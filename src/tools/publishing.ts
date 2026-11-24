import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { youtube_v3 } from "@googleapis/youtube";
import { withAuthRetry } from "../auth/middleware.js";
import { buildYouTubeClient } from "../youtube/client.js";
import { setPrivacy, schedulePublish } from "../youtube/publishing.js";
import { getVideo } from "../youtube/videos.js";
import { evaluatePublishGate } from "../publishing/gate.js";
import type { ApprovalSnapshot, PublishAction } from "../publishing/approvals.js";
import { trackQuota, getQuotaSummary } from "../quota/tracker.js";
import { invalidateRelated } from "../quota/cache.js";
import { QUOTA_COSTS } from "../quota/constants.js";
import { buildErrorResponse, toMcpError } from "../errors/handlers.js";
import { SetPrivacySchema, SchedulePublishSchema } from "../schemas/publishing.js";
import { toolResult } from "./result.js";
import { summarizeVideo } from "./videos.js";

async function snapshotOf(videoId: string, channel?: string): Promise<ApprovalSnapshot> {
  const video = await withAuthRetry(async (auth) => {
    const yt = buildYouTubeClient(auth);
    return getVideo(yt, videoId, ["snippet", "status"]);
  }, channel);
  trackQuota("videos.list", QUOTA_COSTS["videos.list"]);
  const thumbs = video?.snippet?.thumbnails;
  return {
    videoTitle: video?.snippet?.title ?? undefined,
    thumbnailUrl: thumbs?.medium?.url ?? thumbs?.default?.url ?? undefined,
    currentPrivacy: video?.status?.privacyStatus ?? undefined,
  };
}

/** If YouTube kept the video private although we asked otherwise, say why that may be. */
function lockedWarning(video: youtube_v3.Schema$Video, wanted: string): string | undefined {
  const actual = video.status?.privacyStatus;
  if (!actual || actual === wanted) return undefined;
  return `YouTube reports the video is '${actual}', not '${wanted}'. Videos uploaded through an API project that has not passed Google's YouTube API audit are locked as private. See the README section "Publishing limits".`;
}

export function registerPublishingTools(server: McpServer): void {
  server.registerTool(
    "youtube_video_set_privacy",
    {
      description:
        "Change a video's visibility. Setting 'private' is immediate. Making a video 'public' or 'unlisted' is PUBLISHING and needs the owner's approval: " +
        "the first call returns status 'approval_required' with a link; show it to the user, let them approve, then call again with approvalId.",
      inputSchema: SetPrivacySchema,
    },
    async (params) => {
      try {
        let release = (): void => undefined;
        if (params.privacyStatus !== "private") {
          const action: PublishAction = {
            kind: "set_privacy",
            videoId: params.videoId,
            privacyStatus: params.privacyStatus,
          };
          const gate = await evaluatePublishGate({
            action,
            approvalId: params.approvalId,
            confirmPublish: params.confirmPublish,
            snapshot: () => snapshotOf(params.videoId, params.channel),
          });
          if (!gate.allowed) return toolResult(gate.response);
          release = gate.onFailure;
        }

        let video: youtube_v3.Schema$Video;
        try {
          video = await withAuthRetry(async (auth) => {
            const yt = buildYouTubeClient(auth);
            return setPrivacy(yt, params.videoId, params.privacyStatus);
          }, params.channel);
        } catch (err) {
          release();
          throw err;
        }
        trackQuota("videos.update", QUOTA_COSTS["videos.update"]);
        invalidateRelated("videos.update");
        return toolResult({
          success: true,
          data: summarizeVideo(video),
          warning: lockedWarning(video, params.privacyStatus),
          quota: getQuotaSummary(QUOTA_COSTS["videos.update"] ?? 50),
        });
      } catch (err) {
        return toolResult(buildErrorResponse(toMcpError(err), getQuotaSummary(0)));
      }
    }
  );

  server.registerTool(
    "youtube_video_schedule_publish",
    {
      description:
        "Schedule a video to become public at a future date/time (ISO 8601 with time-zone offset). Scheduling is PUBLISHING and needs the owner's approval: " +
        "the first call returns 'approval_required' with a link; show it to the user, let them approve, then call again with approvalId.",
      inputSchema: SchedulePublishSchema,
    },
    async (params) => {
      try {
        const action: PublishAction = { kind: "schedule", videoId: params.videoId, publishAt: params.publishAt };
        const gate = await evaluatePublishGate({
          action,
          approvalId: params.approvalId,
          confirmPublish: params.confirmPublish,
          snapshot: () => snapshotOf(params.videoId, params.channel),
        });
        if (!gate.allowed) return toolResult(gate.response);

        let video: youtube_v3.Schema$Video;
        try {
          video = await withAuthRetry(async (auth) => {
            const yt = buildYouTubeClient(auth);
            return schedulePublish(yt, params.videoId, params.publishAt);
          }, params.channel);
        } catch (err) {
          gate.onFailure();
          throw err;
        }
        trackQuota("videos.update", QUOTA_COSTS["videos.update"]);
        invalidateRelated("videos.update");
        const scheduled = video.status?.publishAt;
        return toolResult({
          success: true,
          data: summarizeVideo(video),
          warning: scheduled
            ? undefined
            : "YouTube did not report a publishAt time for this video. Videos uploaded through an unaudited API project are locked private; see the README section \"Publishing limits\".",
          quota: getQuotaSummary(QUOTA_COSTS["videos.update"] ?? 50),
        });
      } catch (err) {
        return toolResult(buildErrorResponse(toMcpError(err), getQuotaSummary(0)));
      }
    }
  );
}
