import { z } from "zod";
import { channelField } from "./common.js";

const privacyStatus = z.enum(["public", "private", "unlisted"]);

export const CreatePlaylistSchema = z.object({
  title: z.string().min(1).max(150),
  description: z.string().max(5000).optional(),
  privacyStatus,
  defaultLanguage: z.string().max(20).optional(),
  tags: z.array(z.string().min(1).max(100)).max(50).optional(),
  ...channelField,
});

export const UpdatePlaylistSchema = z.object({
  playlistId: z.string().min(1).max(64),
  title: z.string().min(1).max(150).optional(),
  description: z.string().max(5000).optional(),
  privacyStatus: privacyStatus.optional(),
  ...channelField,
});

export const DeletePlaylistSchema = z.object({
  playlistId: z.string().min(1).max(64),
  confirm: z.literal(true, {
    errorMap: () => ({ message: "confirm must be exactly true to prevent accidental deletion" }),
  }),
  ...channelField,
});

export const GetPlaylistSchema = z.object({
  playlistId: z.string().min(1).max(64),
  parts: z.array(z.string().max(40)).max(10).optional(),
  ...channelField,
});

export const ListPlaylistsSchema = z.object({
  channelId: z.string().max(64).optional(),
  maxResults: z.number().int().min(1).max(50).default(25),
  pageToken: z.string().max(500).optional(),
  ...channelField,
});

export const AddVideoToPlaylistSchema = z.object({
  playlistId: z.string().min(1).max(64),
  videoId: z.string().min(1).max(64),
  position: z.number().int().min(0).optional(),
  ...channelField,
});

export const RemoveVideoFromPlaylistSchema = z.object({
  playlistItemId: z.string().min(1).max(64),
  ...channelField,
});

export const ReorderPlaylistItemSchema = z.object({
  playlistItemId: z.string().min(1).max(64),
  playlistId: z.string().min(1).max(64),
  newPosition: z.number().int().min(0),
  ...channelField,
});

export const ListPlaylistItemsSchema = z.object({
  playlistId: z.string().min(1).max(64),
  maxResults: z.number().int().min(1).max(50).default(50),
  pageToken: z.string().max(500).optional(),
  ...channelField,
});
