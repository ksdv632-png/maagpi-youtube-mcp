import { z } from "zod";
import { channelField } from "./common.js";

export const ListCommentsSchema = z.object({
  videoId: z.string().min(1).max(32).optional().describe("Video to read comments from. Omit to list the latest comments across the whole channel."),
  maxResults: z.number().int().min(1).max(100).default(20),
  pageToken: z.string().max(500).optional(),
  order: z.enum(["time", "relevance"]).default("time"),
  searchTerms: z.string().max(200).optional(),
  ...channelField,
});

export const ReplyCommentSchema = z.object({
  parentCommentId: z.string().min(1).max(100),
  text: z.string().min(1).max(10000),
  ...channelField,
});

export const DeleteCommentSchema = z.object({
  commentId: z.string().min(1).max(100),
  ...channelField,
});

export const ModerateCommentSchema = z.object({
  commentId: z.string().min(1).max(100),
  moderationStatus: z.enum(["published", "heldForReview", "rejected"]),
  banAuthor: z.boolean().default(false),
  ...channelField,
});

export const GetCommentThreadSchema = z.object({
  commentThreadId: z.string().min(1).max(100),
  maxReplies: z.number().int().min(1).max(100).default(20),
  ...channelField,
});
