import fs from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { config } from "../config.js";
import { getPrincipal } from "../auth/context.js";
import { withAuthRetry } from "../auth/middleware.js";
import { buildYouTubeClient } from "../youtube/client.js";
import {
  getChannel, getOwnChannelId, patchBranding, setBanner, setWatermark, unsetWatermark,
  listChannelSections, createChannelSection, deleteChannelSection,
} from "../youtube/channels.js";
import { getCached, setCached, invalidateRelated } from "../quota/cache.js";
import { trackQuota, getQuotaSummary } from "../quota/tracker.js";
import { QUOTA_COSTS } from "../quota/constants.js";
import { YouTubeMcpError } from "../errors/types.js";
import { buildErrorResponse, toMcpError } from "../errors/handlers.js";
import { YouTubeMcpErrorCode } from "../errors/codes.js";
import { downloadToBuffer } from "../net/safe-download.js";
import { toolResult } from "./result.js";
import {
  GetChannelSchema, UpdateChannelSchema, UpdateBrandingSchema, SetBannerSchema,
  SetWatermarkSchema, UnsetWatermarkSchema,
  ListChannelSectionsSchema, CreateChannelSectionSchema, DeleteChannelSectionSchema,
} from "../schemas/channels.js";
import { MAX_BANNER_BYTES, MAX_WATERMARK_BYTES } from "../schemas/common.js";

async function loadImage(
  params: { imageUrl?: string; imagePath?: string },
  maxBytes: number
): Promise<{ buffer: Buffer; mimeType: string }> {
  if (params.imageUrl) {
    return downloadToBuffer(params.imageUrl, { maxBytes, allowedHosts: config.allowedDownloadHosts });
  }
  if (params.imagePath && !getPrincipal()) {
    const buffer = fs.readFileSync(params.imagePath);
    if (buffer.length > maxBytes) {
      throw new YouTubeMcpError(YouTubeMcpErrorCode.FILE_TOO_LARGE, `Image must be ${Math.round(maxBytes / 1024 / 1024)} MB or smaller.`);
    }
    return { buffer, mimeType: /\.png$/i.test(params.imagePath) ? "image/png" : "image/jpeg" };
  }
  throw new YouTubeMcpError(YouTubeMcpErrorCode.MISSING_REQUIRED_PARAM, "imageUrl is required.");
}

export function registerChannelTools(server: McpServer): void {
  server.registerTool(
    "youtube_channel_get",
    { description: "Get the connected channel's metadata, branding settings, and statistics.", inputSchema: GetChannelSchema },
    async (params) => {
      try {
        const cacheKey = params as Record<string, unknown>;
        const cached = getCached("channels.list", cacheKey);
        if (cached) return toolResult({ success: true, data: cached, quota: getQuotaSummary(0), cached: true });

        const channel = await withAuthRetry(async (auth) => {
          const yt = buildYouTubeClient(auth);
          return getChannel(yt, params.parts as string[] | undefined);
        }, params.channel);
        if (!channel) {
          throw new YouTubeMcpError(YouTubeMcpErrorCode.CHANNEL_NOT_FOUND, "No channel found for the authenticated account.");
        }
        trackQuota("channels.list", QUOTA_COSTS["channels.list"]);
        setCached("channels.list", cacheKey, channel);
        return toolResult({ success: true, data: channel, quota: getQuotaSummary(QUOTA_COSTS["channels.list"] ?? 1) });
      } catch (err) {
        return toolResult(buildErrorResponse(toMcpError(err), getQuotaSummary(0)));
      }
    }
  );

  server.registerTool(
    "youtube_channel_update",
    {
      description:
        "Update channel settings the YouTube API allows: description, keywords, country, default language. " +
        "NOT possible through the API: channel name, @handle, profile picture (change those in the YouTube app/Studio).",
      inputSchema: UpdateChannelSchema,
    },
    async (params) => {
      try {
        const channel = await withAuthRetry(async (auth) => {
          const yt = buildYouTubeClient(auth);
          return patchBranding(yt, params);
        }, params.channel);
        trackQuota("channels.update", QUOTA_COSTS["channels.update"]);
        invalidateRelated("channels.update");
        return toolResult({ success: true, data: channel.brandingSettings, quota: getQuotaSummary(QUOTA_COSTS["channels.update"] ?? 50) });
      } catch (err) {
        return toolResult(buildErrorResponse(toMcpError(err), getQuotaSummary(0)));
      }
    }
  );

  server.registerTool(
    "youtube_channel_branding_update",
    {
      description:
        "Update channel branding options: related channels, featured channels (title + ids), channel trailer for non-subscribers, comment moderation, Analytics tracking id. Use youtube_channel_banner_set for the banner image.",
      inputSchema: UpdateBrandingSchema,
    },
    async (params) => {
      try {
        const channel = await withAuthRetry(async (auth) => {
          const yt = buildYouTubeClient(auth);
          return patchBranding(yt, params);
        }, params.channel);
        trackQuota("channels.update", QUOTA_COSTS["channels.update"]);
        invalidateRelated("channels.update");
        return toolResult({ success: true, data: channel.brandingSettings, quota: getQuotaSummary(QUOTA_COSTS["channels.update"] ?? 50) });
      } catch (err) {
        return toolResult(buildErrorResponse(toMcpError(err), getQuotaSummary(0)));
      }
    }
  );

  server.registerTool(
    "youtube_channel_banner_set",
    {
      description:
        "Set the channel banner image from a link (JPG/PNG, max 6 MB, at least 2048x1152 px; keep important content in the centre 1235x338 safe area).",
      inputSchema: SetBannerSchema,
    },
    async (params) => {
      try {
        const image = await loadImage(params, MAX_BANNER_BYTES);
        const channel = await withAuthRetry(async (auth) => {
          const yt = buildYouTubeClient(auth);
          return setBanner(yt, image);
        }, params.channel);
        trackQuota("channelBanners.insert", QUOTA_COSTS["channelBanners.insert"]);
        trackQuota("channels.list", QUOTA_COSTS["channels.list"]);
        trackQuota("channels.update", QUOTA_COSTS["channels.update"]);
        invalidateRelated("channels.update");
        return toolResult({
          success: true,
          data: { bannerExternalUrl: channel.brandingSettings?.image?.bannerExternalUrl },
          quota: getQuotaSummary(QUOTA_COSTS["channelBanners.insert"] ?? 50),
        });
      } catch (err) {
        return toolResult(buildErrorResponse(toMcpError(err), getQuotaSummary(0)));
      }
    }
  );

  server.registerTool(
    "youtube_channel_watermark_set",
    {
      description: "Set the branding watermark shown on all channel videos (image link, PNG recommended, max 1 MB).",
      inputSchema: SetWatermarkSchema,
    },
    async (params) => {
      try {
        const image = await loadImage(params, MAX_WATERMARK_BYTES);
        await withAuthRetry(async (auth) => {
          const yt = buildYouTubeClient(auth);
          const channelId = await getOwnChannelId(yt);
          await setWatermark(yt, channelId, image, params.position, params.timing);
        }, params.channel);
        trackQuota("watermarks.set", QUOTA_COSTS["watermarks.set"]);
        return toolResult({ success: true, data: { watermarkSet: true }, quota: getQuotaSummary(QUOTA_COSTS["watermarks.set"] ?? 50) });
      } catch (err) {
        return toolResult(buildErrorResponse(toMcpError(err), getQuotaSummary(0)));
      }
    }
  );

  server.registerTool(
    "youtube_channel_watermark_unset",
    { description: "Remove the branding watermark from all channel videos.", inputSchema: UnsetWatermarkSchema },
    async (params) => {
      try {
        await withAuthRetry(async (auth) => {
          const yt = buildYouTubeClient(auth);
          const channelId = await getOwnChannelId(yt);
          await unsetWatermark(yt, channelId);
        }, params.channel);
        trackQuota("watermarks.unset", QUOTA_COSTS["watermarks.unset"]);
        return toolResult({ success: true, data: { watermarkRemoved: true }, quota: getQuotaSummary(QUOTA_COSTS["watermarks.unset"] ?? 50) });
      } catch (err) {
        return toolResult(buildErrorResponse(toMcpError(err), getQuotaSummary(0)));
      }
    }
  );

  server.registerTool(
    "youtube_channel_section_list",
    { description: "List all sections on the channel homepage.", inputSchema: ListChannelSectionsSchema },
    async (params) => {
      try {
        const cacheKey = params as Record<string, unknown>;
        const cached = getCached("channelSections.list", cacheKey);
        if (cached) return toolResult({ success: true, data: cached, quota: getQuotaSummary(0), cached: true });

        const sections = await withAuthRetry(async (auth) => {
          const yt = buildYouTubeClient(auth);
          return listChannelSections(yt, params.channelId);
        }, params.channel);
        trackQuota("channelSections.list", QUOTA_COSTS["channelSections.list"]);
        setCached("channelSections.list", cacheKey, sections);
        return toolResult({ success: true, data: sections, quota: getQuotaSummary(QUOTA_COSTS["channelSections.list"] ?? 1) });
      } catch (err) {
        return toolResult(buildErrorResponse(toMcpError(err), getQuotaSummary(0)));
      }
    }
  );

  server.registerTool(
    "youtube_channel_section_create",
    { description: "Create a new channel homepage section featuring playlists or channels.", inputSchema: CreateChannelSectionSchema },
    async (params) => {
      try {
        const section = await withAuthRetry(async (auth) => {
          const yt = buildYouTubeClient(auth);
          return createChannelSection(yt, params);
        }, params.channel);
        trackQuota("channelSections.insert", QUOTA_COSTS["channelSections.insert"]);
        invalidateRelated("channelSections.insert");
        return toolResult({ success: true, data: section, quota: getQuotaSummary(QUOTA_COSTS["channelSections.insert"] ?? 50) });
      } catch (err) {
        return toolResult(buildErrorResponse(toMcpError(err), getQuotaSummary(0)));
      }
    }
  );

  if (config.allowDestructive) {
    server.registerTool(
      "youtube_channel_section_delete",
      { description: "Delete a channel homepage section by ID.", inputSchema: DeleteChannelSectionSchema },
      async (params) => {
        try {
          await withAuthRetry(async (auth) => {
            const yt = buildYouTubeClient(auth);
            await deleteChannelSection(yt, params.sectionId);
          }, params.channel);
          trackQuota("channelSections.delete", QUOTA_COSTS["channelSections.delete"]);
          invalidateRelated("channelSections.delete");
          return toolResult({ success: true, data: { deleted: params.sectionId }, quota: getQuotaSummary(QUOTA_COSTS["channelSections.delete"] ?? 50) });
        } catch (err) {
          return toolResult(buildErrorResponse(toMcpError(err), getQuotaSummary(0)));
        }
      }
    );
  }
}
