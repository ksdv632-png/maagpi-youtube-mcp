import { Readable } from "node:stream";
import { wrapApiCall } from "../errors/handlers.js";
import { withBackoff } from "../quota/backoff.js";
import type { YouTubeClient } from "./client.js";
import type { youtube_v3 } from "@googleapis/youtube";

export interface UploadVideoParams {
  title: string;
  description?: string;
  tags?: string[];
  categoryId?: string;
  language?: string;
  notifySubscribers?: boolean;
  madeForKids?: boolean;
  isShort?: boolean;
}

export interface UpdateVideoParams {
  videoId: string;
  title?: string;
  description?: string;
  tags?: string[];
  categoryId?: string;
  defaultLanguage?: string;
}

export interface UploadMedia {
  body: Readable;
  mimeType?: string;
}

/** YouTube has no Shorts flag; the hashtag helps classification, the format (vertical, <=3 min) decides. */
export function withShortsTag(description: string | undefined): string {
  const text = description ?? "";
  return /#shorts\b/i.test(text) ? text : `${text}${text ? "\n\n" : ""}#Shorts`;
}

/**
 * Uploads a video. It is ALWAYS created as private: publishing is a separate step that needs the
 * owner's approval (see publishing/gate.ts). A single attempt only — a consumed stream cannot be
 * replayed, so there is deliberately no automatic retry here.
 */
export async function uploadVideo(
  yt: YouTubeClient,
  params: UploadVideoParams,
  media: UploadMedia
): Promise<youtube_v3.Schema$Video> {
  return wrapApiCall("videos.insert", async () => {
    const response = await yt.videos.insert({
      part: ["snippet", "status"],
      notifySubscribers: params.notifySubscribers ?? true,
      requestBody: {
        snippet: {
          title: params.title,
          description: params.isShort ? withShortsTag(params.description) : (params.description ?? ""),
          tags: params.tags ?? [],
          categoryId: params.categoryId ?? "22",
          ...(params.language ? { defaultLanguage: params.language } : {}),
        },
        status: {
          privacyStatus: "private",
          selfDeclaredMadeForKids: params.madeForKids ?? false,
        },
      },
      media: { mimeType: media.mimeType ?? "video/*", body: media.body },
    });
    return response.data;
  });
}

export async function getVideo(
  yt: YouTubeClient,
  videoId: string,
  parts: string[] = ["snippet", "status", "statistics", "contentDetails"]
): Promise<youtube_v3.Schema$Video | null> {
  return wrapApiCall("videos.list", () =>
    withBackoff(async () => {
      const response = await yt.videos.list({ id: [videoId], part: parts });
      return response.data.items?.[0] ?? null;
    }, "videos.list")
  );
}

export interface ListVideosResult {
  items: youtube_v3.Schema$Video[];
  nextPageToken?: string;
  totalResults: number;
  /** Quota units this call really cost (search is 100, playlist listing is 2). */
  quotaCost: number;
}

async function hydrateVideos(yt: YouTubeClient, ids: string[]): Promise<youtube_v3.Schema$Video[]> {
  if (ids.length === 0) return [];
  const details = await yt.videos.list({ part: ["snippet", "status", "statistics"], id: ids });
  return details.data.items ?? [];
}

export async function listVideos(
  yt: YouTubeClient,
  params: {
    channelId?: string;
    playlistId?: string;
    query?: string;
    maxResults?: number;
    pageToken?: string;
    order?: "date" | "rating" | "relevance" | "title" | "viewCount";
    publishedAfter?: string;
    publishedBefore?: string;
  }
): Promise<ListVideosResult> {
  return wrapApiCall("videos.list", () =>
    withBackoff(async () => {
      const useSearch = !!params.query || !!params.channelId;
      if (!useSearch) {
        // Cheap path (1 + 1 quota units): the channel's own "uploads" playlist, or any given playlist.
        let playlistId = params.playlistId;
        let cost = 1;
        if (!playlistId) {
          const channel = await yt.channels.list({ part: ["contentDetails"], mine: true });
          playlistId = channel.data.items?.[0]?.contentDetails?.relatedPlaylists?.uploads ?? undefined;
          cost += 1;
        }
        if (!playlistId) return { items: [], totalResults: 0, quotaCost: cost };
        const page = await yt.playlistItems.list({
          part: ["contentDetails"],
          playlistId,
          maxResults: params.maxResults ?? 25,
          pageToken: params.pageToken,
        });
        const ids = (page.data.items ?? [])
          .map((i) => i.contentDetails?.videoId)
          .filter((id): id is string => !!id);
        return {
          items: await hydrateVideos(yt, ids),
          nextPageToken: page.data.nextPageToken ?? undefined,
          totalResults: page.data.pageInfo?.totalResults ?? ids.length,
          quotaCost: cost + (ids.length ? 1 : 0),
        };
      }

      const response = await yt.search.list({
        part: ["snippet"],
        channelId: params.channelId,
        q: params.query,
        forMine: !params.channelId && !params.query ? true : undefined,
        maxResults: params.maxResults ?? 25,
        pageToken: params.pageToken,
        order: params.order ?? "date",
        publishedAfter: params.publishedAfter,
        publishedBefore: params.publishedBefore,
        type: ["video"],
      });
      const ids = (response.data.items ?? [])
        .map((i) => i.id?.videoId)
        .filter((id): id is string => !!id);
      return {
        items: await hydrateVideos(yt, ids),
        nextPageToken: response.data.nextPageToken ?? undefined,
        totalResults: response.data.pageInfo?.totalResults ?? 0,
        quotaCost: 100 + (ids.length ? 1 : 0),
      };
    }, "videos.list")
  );
}

export async function updateVideo(
  yt: YouTubeClient,
  params: UpdateVideoParams
): Promise<youtube_v3.Schema$Video> {
  const current = await getVideo(yt, params.videoId, ["snippet"]);
  const currentSnippet = current?.snippet ?? {};

  return wrapApiCall("videos.update", () =>
    withBackoff(async () => {
      const response = await yt.videos.update({
        part: ["snippet"],
        requestBody: {
          id: params.videoId,
          snippet: {
            ...currentSnippet,
            title: params.title ?? currentSnippet.title,
            description: params.description ?? currentSnippet.description,
            tags: params.tags ?? currentSnippet.tags,
            categoryId: params.categoryId ?? currentSnippet.categoryId,
            defaultLanguage: params.defaultLanguage ?? currentSnippet.defaultLanguage,
          },
        },
      });
      return response.data;
    }, "videos.update")
  );
}

export async function rateVideo(
  yt: YouTubeClient,
  videoId: string,
  rating: "like" | "dislike" | "none"
): Promise<void> {
  return wrapApiCall("videos.rate", () =>
    withBackoff(async () => {
      await yt.videos.rate({ id: videoId, rating });
    }, "videos.rate")
  );
}

export async function setThumbnail(
  yt: YouTubeClient,
  videoId: string,
  image: { buffer: Buffer; mimeType: string }
): Promise<youtube_v3.Schema$ThumbnailSetResponse> {
  return wrapApiCall("thumbnails.set", () =>
    withBackoff(async () => {
      const response = await yt.thumbnails.set({
        videoId,
        media: { mimeType: image.mimeType, body: Readable.from(image.buffer) },
      });
      return response.data;
    }, "thumbnails.set")
  );
}
