import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { config } from "../config.js";
import { withAuthRetry } from "../auth/middleware.js";
import { buildYouTubeClient } from "../youtube/client.js";
import { getOwnChannelId } from "../youtube/channels.js";
import {
  listCommentThreads, getCommentThread, replyToComment,
  deleteComment, moderateComment,
} from "../youtube/comments.js";
import { getCached, setCached, invalidateRelated } from "../quota/cache.js";
import { trackQuota, getQuotaSummary } from "../quota/tracker.js";
import { QUOTA_COSTS } from "../quota/constants.js";
import { YouTubeMcpError } from "../errors/types.js";
import { buildErrorResponse, toMcpError } from "../errors/handlers.js";
import { toolResult } from "./result.js";
import { YouTubeMcpErrorCode } from "../errors/codes.js";
import {
  ListCommentsSchema, ReplyCommentSchema, DeleteCommentSchema,
  ModerateCommentSchema, GetCommentThreadSchema,
} from "../schemas/comments.js";

export function registerCommentTools(server: McpServer): void {
  server.registerTool(
    "youtube_comment_list",
    {
      description:
        "List comment threads (with replies) on one video, or — when videoId is omitted — the latest comments across the whole channel. Supports search and ordering. Use youtube_comment_reply to answer.",
      inputSchema: ListCommentsSchema,
    },
    async (params) => {
      try {
        const cacheKey = params as Record<string, unknown>;
        const cached = getCached("commentThreads.list", cacheKey);
        if (cached) return toolResult({ success: true, data: cached, quota: getQuotaSummary(0), cached: true });

        const result = await withAuthRetry(async (auth) => {
          const yt = buildYouTubeClient(auth);
          if (params.videoId) return listCommentThreads(yt, params.videoId, params);
          const channelId = await getOwnChannelId(yt);
          trackQuota("channels.list", QUOTA_COSTS["channels.list"]);
          return listCommentThreads(yt, { channelId }, params);
        }, params.channel);
        trackQuota("commentThreads.list", QUOTA_COSTS["commentThreads.list"]);
        setCached("commentThreads.list", cacheKey, result);
        return toolResult({ success: true, data: result, quota: getQuotaSummary(QUOTA_COSTS["commentThreads.list"] ?? 1) });
      } catch (err) {
        return toolResult(buildErrorResponse(toMcpError(err), getQuotaSummary(0)));
      }
    }
  );

  server.registerTool(
    "youtube_comment_thread_get",
    { description: "Get a single comment thread with its replies.", inputSchema: GetCommentThreadSchema },
    async (params) => {
      try {
        const thread = await withAuthRetry(async (auth) => {
          const yt = buildYouTubeClient(auth);
          return getCommentThread(yt, params.commentThreadId, params.maxReplies);
        }, params.channel);
        if (!thread) {
          throw new YouTubeMcpError(YouTubeMcpErrorCode.COMMENT_NOT_FOUND, `Comment thread '${params.commentThreadId}' not found.`);
        }
        trackQuota("commentThreads.list", QUOTA_COSTS["commentThreads.list"]);
        return toolResult({ success: true, data: thread, quota: getQuotaSummary(QUOTA_COSTS["commentThreads.list"] ?? 1) });
      } catch (err) {
        return toolResult(buildErrorResponse(toMcpError(err), getQuotaSummary(0)));
      }
    }
  );

  server.registerTool(
    "youtube_comment_reply",
    {
      description:
        "Post a PUBLIC reply to a top-level comment. Always show the user the exact reply text and get their OK before calling this.",
      inputSchema: ReplyCommentSchema,
    },
    async (params) => {
      try {
        const comment = await withAuthRetry(async (auth) => {
          const yt = buildYouTubeClient(auth);
          return replyToComment(yt, params.parentCommentId, params.text);
        }, params.channel);
        trackQuota("comments.insert", QUOTA_COSTS["comments.insert"]);
        invalidateRelated("comments.insert");
        return toolResult({ success: true, data: comment, quota: getQuotaSummary(QUOTA_COSTS["comments.insert"] ?? 50) });
      } catch (err) {
        return toolResult(buildErrorResponse(toMcpError(err), getQuotaSummary(0)));
      }
    }
  );

  if (config.allowDestructive) {
    server.registerTool(
      "youtube_comment_delete",
      { description: "Delete a comment by ID. Only works on comments owned by the authenticated account.", inputSchema: DeleteCommentSchema },
      async (params) => {
        try {
          await withAuthRetry(async (auth) => {
            const yt = buildYouTubeClient(auth);
            await deleteComment(yt, params.commentId);
          }, params.channel);
          trackQuota("comments.delete", QUOTA_COSTS["comments.delete"]);
          invalidateRelated("comments.delete");
          return toolResult({ success: true, data: { deleted: params.commentId }, quota: getQuotaSummary(QUOTA_COSTS["comments.delete"] ?? 50) });
        } catch (err) {
          return toolResult(buildErrorResponse(toMcpError(err), getQuotaSummary(0)));
        }
      }
    );
  }

  server.registerTool(
    "youtube_comment_moderate",
    { description: "Change moderation status of a comment: publish, hold for review, or reject. Optionally ban the author.", inputSchema: ModerateCommentSchema },
    async (params) => {
      try {
        await withAuthRetry(async (auth) => {
          const yt = buildYouTubeClient(auth);
          await moderateComment(yt, params.commentId, params.moderationStatus, params.banAuthor);
        }, params.channel);
        trackQuota("comments.setModerationStatus", QUOTA_COSTS["comments.setModerationStatus"]);
        invalidateRelated("comments.setModerationStatus");
        return toolResult({ success: true, data: { commentId: params.commentId, moderationStatus: params.moderationStatus }, quota: getQuotaSummary(QUOTA_COSTS["comments.setModerationStatus"] ?? 50) });
      } catch (err) {
        return toolResult(buildErrorResponse(toMcpError(err), getQuotaSummary(0)));
      }
    }
  );
}
