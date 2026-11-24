import { z } from "zod";
import { allowLocalFiles, channelField, httpsUrl } from "./common.js";

export const GetChannelSchema = z.object({
  parts: z.array(z.string().max(40)).max(10).optional(),
  ...channelField,
});

export const UpdateChannelSchema = z.object({
  description: z.string().max(1000).optional().describe("Channel description (max 1000 characters)."),
  keywords: z.array(z.string().min(1).max(100)).max(50).optional().describe("Channel keywords."),
  country: z.string().length(2).optional().describe("ISO 3166-1 alpha-2 country code, e.g. UA."),
  defaultLanguage: z.string().max(20).optional().describe("Default language of the channel, e.g. uk or en."),
  ...channelField,
});

export const UpdateBrandingSchema = z.object({
  showRelatedChannels: z.boolean().optional(),
  featuredChannelsTitle: z.string().max(30).optional(),
  featuredChannelsUrls: z.array(z.string().min(1).max(64)).max(100).optional().describe("Channel ids to feature."),
  unsubscribedTrailer: z.string().max(32).optional().describe("Video id shown as the channel trailer for non-subscribers."),
  moderateComments: z.boolean().optional().describe("Hold comments for review (channel-wide)."),
  trackingAnalyticsAccountId: z.string().max(40).optional().describe("Google Analytics tracking id."),
  ...channelField,
});

const imageSource = (maxMb: number, what: string) =>
  (allowLocalFiles
    ? {
        imageUrl: httpsUrl("imageUrl").optional().describe(`https link to the ${what} (max ${maxMb} MB), or use imagePath.`),
        imagePath: z.string().min(1).max(4096).optional().describe(`Path of the ${what} file on this computer.`),
      }
    : {
        imageUrl: httpsUrl("imageUrl").describe(`https link to the ${what} (max ${maxMb} MB). Google Drive/Dropbox share links work.`),
      }) as unknown as { imageUrl: z.ZodOptional<z.ZodString>; imagePath: z.ZodOptional<z.ZodString> };

export const SetBannerSchema = z.object({
  ...imageSource(6, "channel banner (JPG/PNG, at least 2048x1152 px)"),
  ...channelField,
});

export const SetWatermarkSchema = z.object({
  ...imageSource(1, "watermark image (PNG recommended, square)"),
  position: z
    .object({
      cornerPosition: z.enum(["topLeft", "topRight", "bottomLeft", "bottomRight"]),
      type: z.literal("corner"),
    })
    .default({ cornerPosition: "bottomRight", type: "corner" }),
  timing: z
    .object({
      type: z.enum(["offsetFromStart", "offsetFromEnd"]),
      offsetMs: z.number().int().min(0),
      durationMs: z.number().int().min(0),
    })
    .default({ type: "offsetFromStart", offsetMs: 0, durationMs: 0 })
    .describe("durationMs 0 = show for the whole video."),
  ...channelField,
});

export const UnsetWatermarkSchema = z.object({
  ...channelField,
});

export const ListChannelSectionsSchema = z.object({
  channelId: z.string().max(64).optional(),
  ...channelField,
});

export const CreateChannelSectionSchema = z.object({
  type: z.string().min(1).max(60),
  title: z.string().max(100).optional(),
  position: z.number().int().min(0).optional(),
  playlistIds: z.array(z.string().max(64)).max(50).optional(),
  channelIds: z.array(z.string().max(64)).max(50).optional(),
  ...channelField,
});

export const DeleteChannelSectionSchema = z.object({
  sectionId: z.string().min(1).max(64),
  ...channelField,
});
