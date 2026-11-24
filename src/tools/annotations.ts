import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

/**
 * MCP tool annotations. Claude uses them to split tools into "read-only" and "write/delete"
 * groups, so the owner can auto-allow reading and still be asked before anything changes.
 */
const read: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const write: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
const idempotentWrite: ToolAnnotations = { ...write, idempotentHint: true };
const destructive: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };
const localRead: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

export const TOOL_ANNOTATIONS: Record<string, ToolAnnotations> = {
  // account
  youtube_account_current: read,
  youtube_account_list: localRead,
  youtube_account_add: write,
  youtube_account_switch: idempotentWrite,
  youtube_account_remove: destructive,
  // videos
  youtube_video_upload: write,
  youtube_upload_status: localRead,
  youtube_video_get: read,
  youtube_video_list: read,
  youtube_video_update: idempotentWrite,
  youtube_video_rate: idempotentWrite,
  youtube_video_set_thumbnail: idempotentWrite,
  // publishing (gated by the owner's approval)
  youtube_video_set_privacy: idempotentWrite,
  youtube_video_schedule_publish: idempotentWrite,
  // analytics
  youtube_analytics_video_metrics: read,
  youtube_analytics_channel_metrics: read,
  youtube_analytics_top_videos: read,
  youtube_analytics_audience_retention: read,
  youtube_analytics_revenue_report: read,
  // comments
  youtube_comment_list: read,
  youtube_comment_thread_get: read,
  youtube_comment_reply: write,
  youtube_comment_moderate: destructive,
  youtube_comment_delete: destructive,
  // playlists
  youtube_playlist_create: write,
  youtube_playlist_update: idempotentWrite,
  youtube_playlist_delete: destructive,
  youtube_playlist_get: read,
  youtube_playlist_list: read,
  youtube_playlist_item_add: write,
  youtube_playlist_item_remove: destructive,
  youtube_playlist_item_reorder: idempotentWrite,
  youtube_playlist_items_list: read,
  // channel
  youtube_channel_get: read,
  youtube_channel_update: idempotentWrite,
  youtube_channel_branding_update: idempotentWrite,
  youtube_channel_banner_set: idempotentWrite,
  youtube_channel_watermark_set: idempotentWrite,
  youtube_channel_watermark_unset: destructive,
  youtube_channel_section_list: read,
  youtube_channel_section_create: write,
  youtube_channel_section_delete: destructive,
};
