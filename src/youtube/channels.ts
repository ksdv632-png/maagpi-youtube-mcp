import { Readable } from "node:stream";
import { wrapApiCall } from "../errors/handlers.js";
import { withBackoff } from "../quota/backoff.js";
import { YouTubeMcpError } from "../errors/types.js";
import { YouTubeMcpErrorCode } from "../errors/codes.js";
import type { YouTubeClient } from "./client.js";
import type { youtube_v3 } from "@googleapis/youtube";

export async function getChannel(
  yt: YouTubeClient,
  parts: string[] = ["snippet", "brandingSettings", "statistics", "contentDetails"]
): Promise<youtube_v3.Schema$Channel | null> {
  return wrapApiCall("channels.list", () =>
    withBackoff(async () => {
      const response = await yt.channels.list({ part: parts, mine: true });
      return response.data.items?.[0] ?? null;
    }, "channels.list")
  );
}

export async function getOwnChannelId(yt: YouTubeClient): Promise<string> {
  const channel = await getChannel(yt, ["id"]);
  if (!channel?.id) {
    throw new YouTubeMcpError(YouTubeMcpErrorCode.CHANNEL_NOT_FOUND, "No YouTube channel found for the connected account.");
  }
  return channel.id;
}

/** YouTube stores keywords as one space-separated string; multi-word keywords are quoted. */
export function formatKeywords(keywords: string[]): string {
  return keywords
    .map((k) => k.replace(/"/g, "").trim())
    .filter(Boolean)
    .map((k) => (/\s/.test(k) ? `"${k}"` : k))
    .join(" ");
}

export interface BrandingPatch {
  description?: string;
  keywords?: string[];
  country?: string;
  defaultLanguage?: string;
  showRelatedChannels?: boolean;
  featuredChannelsTitle?: string;
  featuredChannelsUrls?: string[];
  unsubscribedTrailer?: string;
  moderateComments?: boolean;
  trackingAnalyticsAccountId?: string;
  bannerExternalUrl?: string;
}

/**
 * channels.update only accepts brandingSettings (the channel NAME, handle and avatar cannot be changed
 * through the API). The part is overwritten as a whole, so the current settings are read first and merged.
 */
export async function patchBranding(yt: YouTubeClient, patch: BrandingPatch): Promise<youtube_v3.Schema$Channel> {
  const current = await getChannel(yt, ["id", "brandingSettings"]);
  if (!current?.id) {
    throw new YouTubeMcpError(YouTubeMcpErrorCode.CHANNEL_NOT_FOUND, "No YouTube channel found for the connected account.");
  }
  const channelSettings: youtube_v3.Schema$ChannelSettings = { ...current.brandingSettings?.channel };
  if (patch.description !== undefined) channelSettings.description = patch.description;
  if (patch.keywords !== undefined) channelSettings.keywords = formatKeywords(patch.keywords);
  if (patch.country !== undefined) channelSettings.country = patch.country.toUpperCase();
  if (patch.defaultLanguage !== undefined) channelSettings.defaultLanguage = patch.defaultLanguage;
  if (patch.showRelatedChannels !== undefined) channelSettings.showRelatedChannels = patch.showRelatedChannels;
  if (patch.featuredChannelsTitle !== undefined) channelSettings.featuredChannelsTitle = patch.featuredChannelsTitle;
  if (patch.featuredChannelsUrls !== undefined) channelSettings.featuredChannelsUrls = patch.featuredChannelsUrls;
  if (patch.unsubscribedTrailer !== undefined) channelSettings.unsubscribedTrailer = patch.unsubscribedTrailer;
  if (patch.moderateComments !== undefined) channelSettings.moderateComments = patch.moderateComments;
  if (patch.trackingAnalyticsAccountId !== undefined) {
    channelSettings.trackingAnalyticsAccountId = patch.trackingAnalyticsAccountId;
  }
  const image: youtube_v3.Schema$ImageSettings = { ...current.brandingSettings?.image };
  if (patch.bannerExternalUrl !== undefined) image.bannerExternalUrl = patch.bannerExternalUrl;

  return wrapApiCall("channels.update", () =>
    withBackoff(async () => {
      const response = await yt.channels.update({
        part: ["brandingSettings"],
        requestBody: {
          id: current.id!,
          brandingSettings: { channel: channelSettings, image },
        },
      });
      return response.data;
    }, "channels.update")
  );
}

export async function setBanner(
  yt: YouTubeClient,
  img: { buffer: Buffer; mimeType: string }
): Promise<youtube_v3.Schema$Channel> {
  const uploaded = await wrapApiCall("channelBanners.insert", () =>
    withBackoff(async () => {
      const response = await yt.channelBanners.insert({
        media: { mimeType: img.mimeType, body: Readable.from(img.buffer) },
      });
      return response.data;
    }, "channelBanners.insert")
  );
  if (!uploaded.url) {
    throw new YouTubeMcpError(YouTubeMcpErrorCode.INTERNAL_ERROR, "YouTube did not return a banner URL.");
  }
  return patchBranding(yt, { bannerExternalUrl: uploaded.url });
}

export async function setWatermark(
  yt: YouTubeClient,
  channelId: string,
  img: { buffer: Buffer; mimeType: string },
  position: { cornerPosition: "topLeft" | "topRight" | "bottomLeft" | "bottomRight"; type: "corner" },
  timing: { type: "offsetFromStart" | "offsetFromEnd"; offsetMs: number; durationMs: number }
): Promise<void> {
  return wrapApiCall("watermarks.set", () =>
    withBackoff(async () => {
      await yt.watermarks.set({
        channelId,
        requestBody: {
          position: { cornerPosition: position.cornerPosition, type: position.type },
          timing: {
            type: timing.type,
            offsetMs: String(timing.offsetMs),
            ...(timing.durationMs > 0 ? { durationMs: String(timing.durationMs) } : {}),
          },
        },
        media: { mimeType: img.mimeType, body: Readable.from(img.buffer) },
      });
    }, "watermarks.set")
  );
}

export async function unsetWatermark(yt: YouTubeClient, channelId: string): Promise<void> {
  return wrapApiCall("watermarks.unset", () =>
    withBackoff(async () => {
      await yt.watermarks.unset({ channelId });
    }, "watermarks.unset")
  );
}

export async function listChannelSections(
  yt: YouTubeClient,
  channelId?: string
): Promise<youtube_v3.Schema$ChannelSection[]> {
  return wrapApiCall("channelSections.list", () =>
    withBackoff(async () => {
      const response = await yt.channelSections.list({
        part: ["snippet", "contentDetails"],
        channelId,
        mine: channelId ? undefined : true,
      });
      return response.data.items ?? [];
    }, "channelSections.list")
  );
}

export async function createChannelSection(
  yt: YouTubeClient,
  params: {
    type: string;
    title?: string;
    position?: number;
    playlistIds?: string[];
    channelIds?: string[];
  }
): Promise<youtube_v3.Schema$ChannelSection> {
  return wrapApiCall("channelSections.insert", () =>
    withBackoff(async () => {
      const response = await yt.channelSections.insert({
        part: ["snippet", "contentDetails"],
        requestBody: {
          snippet: { type: params.type, title: params.title, position: params.position },
          contentDetails: { playlists: params.playlistIds, channels: params.channelIds },
        },
      });
      return response.data;
    }, "channelSections.insert")
  );
}

export async function deleteChannelSection(yt: YouTubeClient, sectionId: string): Promise<void> {
  return wrapApiCall("channelSections.delete", () =>
    withBackoff(async () => {
      await yt.channelSections.delete({ id: sectionId });
    }, "channelSections.delete")
  );
}
