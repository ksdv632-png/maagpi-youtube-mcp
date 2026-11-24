import fs from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { youtube_v3 } from "@googleapis/youtube";
import { config } from "../config.js";
import { getPrincipal } from "../auth/context.js";
import { getAuthClient, withAuthRetry } from "../auth/middleware.js";
import { buildYouTubeClient } from "../youtube/client.js";
import {
  uploadVideo, getVideo, listVideos, updateVideo, rateVideo, setThumbnail,
} from "../youtube/videos.js";
import { getCached, setCached, invalidateRelated } from "../quota/cache.js";
import { trackQuota, getQuotaSummary } from "../quota/tracker.js";
import { QUOTA_COSTS } from "../quota/constants.js";
import { YouTubeMcpError } from "../errors/types.js";
import { buildErrorResponse, toMcpError } from "../errors/handlers.js";
import { YouTubeMcpErrorCode } from "../errors/codes.js";
import { logger } from "../logger.js";
import { normalizeCloudUrl, CloudUrlError } from "../net/cloud-url.js";
import {
  assertDownloadUrl, openDownload, downloadToBuffer, ByteLimiter,
} from "../net/safe-download.js";
import { uploadJobs, type UploadJob } from "../jobs/upload-jobs.js";
import { toolResult } from "./result.js";
import {
  UploadVideoSchema, UploadStatusSchema, GetVideoSchema, ListVideosSchema,
  UpdateVideoSchema, RateVideoSchema, SetThumbnailSchema,
} from "../schemas/videos.js";
import { MAX_THUMBNAIL_BYTES, MAX_UPLOAD_BYTES } from "../schemas/common.js";

const owner = (): string => getPrincipal()?.sub ?? "local";

export function summarizeVideo(video: youtube_v3.Schema$Video): Record<string, unknown> {
  const id = video.id ?? undefined;
  return {
    id,
    url: id ? `https://youtu.be/${id}` : undefined,
    studioUrl: id ? `https://studio.youtube.com/video/${id}/edit` : undefined,
    title: video.snippet?.title,
    privacyStatus: video.status?.privacyStatus,
    uploadStatus: video.status?.uploadStatus,
    publishAt: video.status?.publishAt,
  };
}

function describeJob(job: UploadJob): Record<string, unknown> {
  const percent =
    job.bytesTotal && job.bytesTotal > 0
      ? Math.min(100, Math.round((job.bytesTransferred / job.bytesTotal) * 100))
      : undefined;
  return {
    jobId: job.id,
    status: job.status,
    title: job.title,
    source: job.sourceHost,
    megabytesTransferred: Math.round(job.bytesTransferred / 1024 / 1024),
    megabytesTotal: job.bytesTotal ? Math.round(job.bytesTotal / 1024 / 1024) : undefined,
    percent,
    video: job.video,
    warnings: job.warnings.length ? job.warnings : undefined,
    error: job.error,
    hint:
      job.status === "done"
        ? "Uploaded as PRIVATE. To publish, use youtube_video_set_privacy or youtube_video_schedule_publish (the owner must approve)."
        : job.status === "failed"
          ? "The upload failed. Tell the user the reason; they can retry."
          : "Still running. Check again with youtube_upload_status in a little while.",
  };
}

export function registerVideoTools(server: McpServer): void {
  server.registerTool(
    "youtube_video_upload",
    {
      description:
        "Upload a video or YouTube Short from a cloud-storage link (Google Drive/Dropbox 'Anyone with the link', or a direct https link to an MP4/MOV). " +
        "The upload runs in the background: this returns a jobId immediately; poll youtube_upload_status. " +
        "The video is ALWAYS created as PRIVATE — publishing needs the owner's approval (youtube_video_set_privacy / youtube_video_schedule_publish). " +
        "YouTube's API has no Shorts flag: a vertical/square video up to 3 minutes becomes a Short (set isShort to also add #Shorts).",
      inputSchema: UploadVideoSchema,
    },
    async (params) => {
      try {
        if (params.thumbnailUrl) {
          // Fail fast on a bad cover link instead of after a long upload.
          assertDownloadUrl(new URL(normalizeCloudUrl(params.thumbnailUrl)), config.allowedDownloadHosts);
        }

        // ── local file (stdio mode only): synchronous upload ────────────────────
        if (!params.sourceUrl) {
          if (!params.filePath) {
            throw new YouTubeMcpError(YouTubeMcpErrorCode.MISSING_REQUIRED_PARAM, "sourceUrl is required.");
          }
          if (getPrincipal()) {
            throw new YouTubeMcpError(YouTubeMcpErrorCode.LOCAL_FILES_DISABLED, "Local files are disabled on the remote server. Use sourceUrl.");
          }
          const filePath = params.filePath;
          const video = await withAuthRetry(async (auth) => {
            const yt = buildYouTubeClient(auth);
            return uploadVideo(yt, params, { body: fs.createReadStream(filePath), mimeType: "video/*" });
          }, params.channel);
          trackQuota("videos.insert", QUOTA_COSTS["videos.insert"]);
          invalidateRelated("videos.insert");
          return toolResult({
            success: true,
            data: summarizeVideo(video),
            note: "Uploaded as PRIVATE. Publishing requires confirmation (youtube_video_set_privacy).",
            quota: getQuotaSummary(QUOTA_COSTS["videos.insert"] ?? 1600),
          });
        }

        // ── cloud link: background job ──────────────────────────────────────────
        let sourceHost: string;
        try {
          const url = new URL(normalizeCloudUrl(params.sourceUrl));
          assertDownloadUrl(url, config.allowedDownloadHosts);
          sourceHost = url.hostname;
        } catch (err) {
          if (err instanceof CloudUrlError) {
            throw new YouTubeMcpError(YouTubeMcpErrorCode.INVALID_PARAMS, err.message);
          }
          throw err;
        }

        // Resolve credentials now (inside the request) — the job outlives the request.
        const auth = await getAuthClient(params.channel);
        const yt = buildYouTubeClient(auth);
        const sourceUrl = params.sourceUrl;

        const job = uploadJobs.submit(owner(), { title: params.title, sourceHost }, async (ctl) => {
          ctl.setStatus("downloading");
          const download = await openDownload(sourceUrl, {
            kind: "video",
            maxBytes: MAX_UPLOAD_BYTES,
            allowedHosts: config.allowedDownloadHosts,
          });
          ctl.setTotal(download.contentLength);
          const limiter = new ByteLimiter(MAX_UPLOAD_BYTES, ctl.setBytes);
          download.stream.on("error", (e) => limiter.destroy(e));
          download.stream.pipe(limiter);

          ctl.setStatus("uploading");
          let video: youtube_v3.Schema$Video;
          try {
            video = await uploadVideo(yt, params, { body: limiter, mimeType: download.mimeType });
          } finally {
            download.stream.destroy();
          }
          trackQuota("videos.insert", QUOTA_COSTS["videos.insert"]);
          invalidateRelated("videos.insert");

          if (params.thumbnailUrl && video.id) {
            try {
              const image = await downloadToBuffer(params.thumbnailUrl, {
                maxBytes: MAX_THUMBNAIL_BYTES,
                allowedHosts: config.allowedDownloadHosts,
              });
              await setThumbnail(yt, video.id, image);
              trackQuota("thumbnails.set", QUOTA_COSTS["thumbnails.set"]);
            } catch (err) {
              ctl.warn(`The video was uploaded, but the cover was not set: ${toMcpError(err).message}`);
            }
          }
          return summarizeVideo(video);
        });
        logger.info("Upload job started", { jobId: job.id, host: sourceHost });
        return toolResult({
          success: true,
          data: {
            jobId: job.id,
            status: job.status,
            message:
              "Upload started in the background. Call youtube_upload_status with this jobId to follow progress. The video will be PRIVATE until the owner approves publishing.",
          },
          quota: getQuotaSummary(0),
        });
      } catch (err) {
        return toolResult(buildErrorResponse(toMcpError(err), getQuotaSummary(0)));
      }
    }
  );

  server.registerTool(
    "youtube_upload_status",
    {
      description:
        "Check a background upload started by youtube_video_upload (progress, final video id/link, errors). Omit jobId to list recent uploads.",
      inputSchema: UploadStatusSchema,
    },
    async (params) => {
      try {
        if (params.jobId) {
          const job = uploadJobs.get(owner(), params.jobId);
          if (!job) {
            throw new YouTubeMcpError(
              YouTubeMcpErrorCode.JOB_NOT_FOUND,
              "Upload job not found (unknown id, or the server restarted and forgot it).",
              { suggestedFix: "Check the channel's videos with youtube_video_list before retrying, then start the upload again if needed." }
            );
          }
          return toolResult({ success: true, data: describeJob(job) });
        }
        return toolResult({ success: true, data: uploadJobs.list(owner()).map(describeJob) });
      } catch (err) {
        return toolResult(buildErrorResponse(toMcpError(err), getQuotaSummary(0)));
      }
    }
  );

  server.registerTool(
    "youtube_video_get",
    { description: "Get full metadata for a YouTube video by ID.", inputSchema: GetVideoSchema },
    async (params) => {
      try {
        const cacheKey = { videoId: params.videoId, parts: params.parts };
        const cached = getCached("videos.get", cacheKey);
        if (cached) {
          return toolResult({ success: true, data: cached, quota: getQuotaSummary(0), cached: true });
        }

        const video = await withAuthRetry(async (auth) => {
          const yt = buildYouTubeClient(auth);
          return getVideo(yt, params.videoId, params.parts as string[] | undefined);
        }, params.channel);

        if (!video) {
          throw new YouTubeMcpError(YouTubeMcpErrorCode.VIDEO_NOT_FOUND, `Video '${params.videoId}' not found.`, {
            suggestedFix: "Verify the video ID and ensure the video belongs to the authenticated account.",
          });
        }

        trackQuota("videos.list", QUOTA_COSTS["videos.list"]);
        setCached("videos.get", cacheKey, video);
        return toolResult({ success: true, data: video, quota: getQuotaSummary(QUOTA_COSTS["videos.list"] ?? 1) });
      } catch (err) {
        return toolResult(buildErrorResponse(toMcpError(err), getQuotaSummary(0)));
      }
    }
  );

  server.registerTool(
    "youtube_video_list",
    {
      description:
        "List the connected channel's videos (newest first, including private/unlisted/scheduled ones), the videos of a playlist, or search YouTube. Cheap (2 quota units) unless query/channelId is used (search = 100).",
      inputSchema: ListVideosSchema,
    },
    async (params) => {
      try {
        const cacheKey = params as Record<string, unknown>;
        const cached = getCached("videos.list", cacheKey);
        if (cached) return toolResult({ success: true, data: cached, quota: getQuotaSummary(0), cached: true });

        const result = await withAuthRetry(async (auth) => {
          const yt = buildYouTubeClient(auth);
          return listVideos(yt, params);
        }, params.channel);
        trackQuota("videos.list", result.quotaCost);
        setCached("videos.list", cacheKey, result);
        return toolResult({ success: true, data: result, quota: getQuotaSummary(result.quotaCost) });
      } catch (err) {
        return toolResult(buildErrorResponse(toMcpError(err), getQuotaSummary(0)));
      }
    }
  );

  server.registerTool(
    "youtube_video_update",
    {
      description: "Change a video's title, description, tags, category or default language. Unspecified fields stay as they are.",
      inputSchema: UpdateVideoSchema,
    },
    async (params) => {
      try {
        const video = await withAuthRetry(async (auth) => {
          const yt = buildYouTubeClient(auth);
          return updateVideo(yt, params);
        }, params.channel);
        trackQuota("videos.update", QUOTA_COSTS["videos.update"]);
        invalidateRelated("videos.update");
        return toolResult({ success: true, data: video, quota: getQuotaSummary(QUOTA_COSTS["videos.update"] ?? 50) });
      } catch (err) {
        return toolResult(buildErrorResponse(toMcpError(err), getQuotaSummary(0)));
      }
    }
  );

  server.registerTool(
    "youtube_video_rate",
    { description: "Like, dislike, or remove a rating from a video.", inputSchema: RateVideoSchema },
    async (params) => {
      try {
        await withAuthRetry(async (auth) => {
          const yt = buildYouTubeClient(auth);
          await rateVideo(yt, params.videoId, params.rating);
        }, params.channel);
        trackQuota("videos.rate", QUOTA_COSTS["videos.rate"]);
        return toolResult({ success: true, data: { videoId: params.videoId, rating: params.rating }, quota: getQuotaSummary(QUOTA_COSTS["videos.rate"] ?? 50) });
      } catch (err) {
        return toolResult(buildErrorResponse(toMcpError(err), getQuotaSummary(0)));
      }
    }
  );

  server.registerTool(
    "youtube_video_set_thumbnail",
    {
      description:
        "Set a custom cover (thumbnail) for a video from an image link (JPG/PNG/GIF, max 2 MB, 1280x720 recommended). The YouTube channel must be verified to use custom thumbnails.",
      inputSchema: SetThumbnailSchema,
    },
    async (params) => {
      try {
        let image: { buffer: Buffer; mimeType: string };
        if (params.thumbnailUrl) {
          image = await downloadToBuffer(params.thumbnailUrl, {
            maxBytes: MAX_THUMBNAIL_BYTES,
            allowedHosts: config.allowedDownloadHosts,
          });
        } else if (params.thumbnailPath && !getPrincipal()) {
          const buffer = fs.readFileSync(params.thumbnailPath);
          if (buffer.length > MAX_THUMBNAIL_BYTES) {
            throw new YouTubeMcpError(YouTubeMcpErrorCode.FILE_TOO_LARGE, "Thumbnail must be 2 MB or smaller.");
          }
          image = { buffer, mimeType: /\.png$/i.test(params.thumbnailPath) ? "image/png" : "image/jpeg" };
        } else {
          throw new YouTubeMcpError(YouTubeMcpErrorCode.MISSING_REQUIRED_PARAM, "thumbnailUrl is required.");
        }
        const result = await withAuthRetry(async (auth) => {
          const yt = buildYouTubeClient(auth);
          return setThumbnail(yt, params.videoId, image);
        }, params.channel);
        trackQuota("thumbnails.set", QUOTA_COSTS["thumbnails.set"]);
        invalidateRelated("videos.update");
        return toolResult({ success: true, data: result, quota: getQuotaSummary(QUOTA_COSTS["thumbnails.set"] ?? 50) });
      } catch (err) {
        return toolResult(buildErrorResponse(toMcpError(err), getQuotaSummary(0)));
      }
    }
  );
}
