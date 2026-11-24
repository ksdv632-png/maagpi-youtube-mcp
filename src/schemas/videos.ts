import { z } from "zod";
import { allowLocalFiles, channelField, httpsUrl } from "./common.js";

const videoParts = z
  .array(
    z.enum([
      "contentDetails", "fileDetails", "id", "liveStreamingDetails", "localizations",
      "player", "processingDetails", "recordingDetails", "snippet", "statistics",
      "status", "suggestions", "topicDetails",
    ])
  )
  .max(13);

const tags = z
  .array(z.string().min(1).max(100))
  .max(60)
  .refine((t) => t.join(",").length <= 500, { message: "All tags together may not exceed 500 characters" });

/** Where the video comes from. Remote mode: a cloud-storage link only. Local mode: a link or a file path. */
const sourceShape = (
  allowLocalFiles
    ? {
        sourceUrl: httpsUrl("sourceUrl").optional().describe("https link to the video file in cloud storage (or use filePath)."),
        filePath: z.string().min(1).max(4096).optional().describe("Absolute path of a video file on this computer (or use sourceUrl)."),
      }
    : {
        sourceUrl: httpsUrl("sourceUrl").describe(
          "https link to the MP4/MOV file in cloud storage. Google Drive and Dropbox share links ('Anyone with the link') and direct/pre-signed links work. The file is fetched by the server, never stored on it."
        ),
      }
) as unknown as { sourceUrl: z.ZodOptional<z.ZodString>; filePath: z.ZodOptional<z.ZodString> };

export const UploadVideoSchema = z.object({
  ...sourceShape,
  title: z.string().min(1).max(100),
  description: z.string().max(5000).optional(),
  tags: tags.optional(),
  categoryId: z.string().max(10).optional().describe("YouTube category id (default 22 = People & Blogs)."),
  privacyStatus: z
    .literal("private", {
      errorMap: () => ({
        message:
          "Uploads are always created as private. To publish, upload first, then call youtube_video_set_privacy (needs the owner's approval).",
      }),
    })
    .optional()
    .describe("Always 'private'. Publishing needs the owner's approval (youtube_video_set_privacy)."),
  language: z.string().max(20).optional().describe("Default language of the video, e.g. 'uk' or 'en'."),
  isShort: z
    .boolean()
    .default(false)
    .describe(
      "YouTube has no 'Shorts' flag in its API. A video is a Short when it is vertical/square and up to 3 minutes; this option also adds #Shorts to the description."
    ),
  madeForKids: z.boolean().default(false).describe("Audience declaration (COPPA): is the video made for kids?"),
  notifySubscribers: z.boolean().default(true),
  thumbnailUrl: httpsUrl("thumbnailUrl").optional().describe("https link to a JPG/PNG cover image (max 2 MB), applied after the upload."),
  ...channelField,
});

export const UploadStatusSchema = z.object({
  jobId: z.string().min(1).max(64).optional().describe("Id returned by youtube_video_upload. Omit to list recent uploads."),
});

export const GetVideoSchema = z.object({
  videoId: z.string().min(1, "videoId is required").max(32),
  parts: videoParts.optional(),
  ...channelField,
});

export const ListVideosSchema = z.object({
  channelId: z.string().max(64).optional().describe("List videos of another channel (public videos only, uses search)."),
  playlistId: z.string().max(64).optional().describe("List the videos of this playlist."),
  query: z.string().max(200).optional().describe("Search text (uses the expensive search endpoint: 100 quota units)."),
  maxResults: z.number().int().min(1).max(50).default(25),
  pageToken: z.string().max(500).optional(),
  order: z.enum(["date", "rating", "relevance", "title", "viewCount"]).optional().describe("Only applies to search (query/channelId)."),
  publishedAfter: z.string().datetime({ offset: true }).optional(),
  publishedBefore: z.string().datetime({ offset: true }).optional(),
  ...channelField,
});

export const UpdateVideoSchema = z.object({
  videoId: z.string().min(1, "videoId is required").max(32),
  title: z.string().min(1).max(100).optional(),
  description: z.string().max(5000).optional(),
  tags: tags.optional(),
  categoryId: z.string().max(10).optional(),
  defaultLanguage: z.string().max(20).optional(),
  ...channelField,
});

export const RateVideoSchema = z.object({
  videoId: z.string().min(1, "videoId is required").max(32),
  rating: z.enum(["like", "dislike", "none"]),
  ...channelField,
});

const thumbShape = (
  allowLocalFiles
    ? {
        thumbnailUrl: httpsUrl("thumbnailUrl").optional().describe("https link to a JPG/PNG image, max 2 MB (or use thumbnailPath)."),
        thumbnailPath: z.string().min(1).max(4096).optional().describe("Path of a JPG/PNG file on this computer."),
      }
    : {
        thumbnailUrl: httpsUrl("thumbnailUrl").describe(
          "https link to the cover image (JPG/PNG/GIF, max 2 MB, ideally 1280x720). Google Drive/Dropbox share links work."
        ),
      }
) as unknown as { thumbnailUrl: z.ZodOptional<z.ZodString>; thumbnailPath: z.ZodOptional<z.ZodString> };

export const SetThumbnailSchema = z.object({
  videoId: z.string().min(1, "videoId is required").max(32),
  ...thumbShape,
  ...channelField,
});
