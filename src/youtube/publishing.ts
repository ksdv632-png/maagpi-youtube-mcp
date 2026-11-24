import { wrapApiCall } from "../errors/handlers.js";
import { withBackoff } from "../quota/backoff.js";
import { YouTubeMcpError } from "../errors/types.js";
import { YouTubeMcpErrorCode } from "../errors/codes.js";
import { getVideo } from "./videos.js";
import type { YouTubeClient } from "./client.js";
import type { youtube_v3 } from "@googleapis/youtube";

/**
 * videos.update OVERWRITES every mutable property of the parts it is given, so the writable
 * fields of the current `status` must be sent back, otherwise embeddable / license /
 * publicStatsViewable / made-for-kids would silently reset to defaults.
 */
const WRITABLE_STATUS_FIELDS = [
  "license",
  "embeddable",
  "publicStatsViewable",
  "selfDeclaredMadeForKids",
  "containsSyntheticMedia",
] as const;

function writableStatus(current: youtube_v3.Schema$VideoStatus): youtube_v3.Schema$VideoStatus {
  const keep: Record<string, unknown> = {};
  const source = current as Record<string, unknown>;
  for (const field of WRITABLE_STATUS_FIELDS) {
    if (source[field] !== undefined && source[field] !== null) keep[field] = source[field];
  }
  return keep as youtube_v3.Schema$VideoStatus;
}

async function currentStatus(yt: YouTubeClient, videoId: string): Promise<youtube_v3.Schema$VideoStatus> {
  const video = await getVideo(yt, videoId, ["status"]);
  if (!video) {
    throw new YouTubeMcpError(YouTubeMcpErrorCode.VIDEO_NOT_FOUND, `Video '${videoId}' not found.`, {
      suggestedFix: "Verify the video ID and ensure the video belongs to the connected channel.",
    });
  }
  return video.status ?? {};
}

export async function setPrivacy(
  yt: YouTubeClient,
  videoId: string,
  privacyStatus: "public" | "private" | "unlisted"
): Promise<youtube_v3.Schema$Video> {
  const status = await currentStatus(yt, videoId);
  return wrapApiCall("videos.update", () =>
    withBackoff(async () => {
      const response = await yt.videos.update({
        part: ["status"],
        requestBody: {
          id: videoId,
          // publishAt is deliberately dropped: an explicit privacy change cancels a pending schedule.
          status: { ...writableStatus(status), privacyStatus },
        },
      });
      return response.data;
    }, "videos.update")
  );
}

/** Schedules the video to become public at `publishAt` (YouTube requires privacyStatus=private + publishAt). */
export async function schedulePublish(
  yt: YouTubeClient,
  videoId: string,
  publishAt: string
): Promise<youtube_v3.Schema$Video> {
  const status = await currentStatus(yt, videoId);
  return wrapApiCall("videos.update", () =>
    withBackoff(async () => {
      const response = await yt.videos.update({
        part: ["status"],
        requestBody: {
          id: videoId,
          status: { ...writableStatus(status), privacyStatus: "private", publishAt },
        },
      });
      return response.data;
    }, "videos.update")
  );
}
