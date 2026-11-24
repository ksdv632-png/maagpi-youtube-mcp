import { z } from "zod";
import { config, isRemote } from "../config.js";

/**
 * Local (stdio) mode supports several channel profiles, selected with the `channel` argument.
 * Remote mode has exactly one channel (the one the owner signed in with), so the argument is
 * not offered to the model at all.
 */
export const channelField = (
  isRemote
    ? {}
    : { channel: z.string().optional().describe("Channel profile name. Defaults to active profile.") }
) as unknown as { channel: z.ZodOptional<z.ZodString> };

/** Local file paths are only meaningful (and only allowed) when running on the owner's own machine. */
export const allowLocalFiles = !isRemote;

export const MAX_UPLOAD_BYTES = config.maxUploadMb * 1024 * 1024;
export const MAX_THUMBNAIL_BYTES = 2 * 1024 * 1024;
export const MAX_BANNER_BYTES = 6 * 1024 * 1024;
export const MAX_WATERMARK_BYTES = 1 * 1024 * 1024;

export const httpsUrl = (what: string) =>
  z
    .string()
    .url()
    .max(2048)
    .refine((v) => v.startsWith("https://"), { message: `${what} must be an https:// link` });
