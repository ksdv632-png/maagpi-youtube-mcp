import { z } from "zod";
import { allowLocalFiles, channelField } from "./common.js";

const futureDateTime = z
  .string()
  .datetime({ offset: true })
  .refine((val) => new Date(val) > new Date(), {
    message: "publishAt must be a future datetime",
  });

/**
 * Remote mode: the owner approves on a web page and the assistant passes the resulting approvalId.
 * Local (stdio) mode has no web page: the assistant must pass confirmPublish after the user said yes.
 */
const approvalShape = (
  allowLocalFiles
    ? { confirmPublish: z.boolean().optional().describe("Set true ONLY after the user explicitly agreed to publish.") }
    : {
        approvalId: z
          .string()
          .min(10)
          .max(100)
          .optional()
          .describe(
            "Id of an approval the owner has already granted (from the previous 'approval_required' answer). Omit on the first call."
          ),
      }
) as unknown as {
  approvalId: z.ZodOptional<z.ZodString>;
  confirmPublish: z.ZodOptional<z.ZodBoolean>;
};

export const SetPrivacySchema = z.object({
  videoId: z.string().min(1).max(32),
  privacyStatus: z.enum(["public", "private", "unlisted"]),
  ...approvalShape,
  ...channelField,
});

export const SchedulePublishSchema = z.object({
  videoId: z.string().min(1).max(32),
  publishAt: futureDateTime.describe(
    "Future ISO 8601 date-time WITH time-zone offset, e.g. 2026-12-01T18:00:00+02:00. The video becomes public at that moment."
  ),
  ...approvalShape,
  ...channelField,
});
