import { describe, it, expect, vi } from "vitest";
import { formatKeywords, patchBranding, setWatermark } from "../../../src/youtube/channels.js";
import { listVideos, withShortsTag } from "../../../src/youtube/videos.js";
import { setPrivacy, schedulePublish } from "../../../src/youtube/publishing.js";
import type { YouTubeClient } from "../../../src/youtube/client.js";

const asClient = (o: unknown) => o as YouTubeClient;

describe("formatKeywords", () => {
  it("quotes multi-word keywords and drops quotes/blank entries", () => {
    expect(formatKeywords(["travel", "new york", ' "bad" ', " "])).toBe('travel "new york" bad');
  });
});

describe("patchBranding", () => {
  const current = {
    id: "UC1",
    brandingSettings: {
      channel: { title: "Name", description: "old", keywords: "a b", country: "UA", showRelatedChannels: true },
      image: { bannerExternalUrl: "https://yt3.example/banner" },
    },
  };

  it("merges into the current settings (nothing else is wiped) and only sends brandingSettings", async () => {
    const update = vi.fn(async (req: unknown) => ({ data: req }));
    const yt = asClient({ channels: { list: async () => ({ data: { items: [current] } }), update } });
    await patchBranding(yt, { description: "new text", keywords: ["x", "two words"] });
    const req = update.mock.calls[0]![0] as any;
    expect(req.part).toEqual(["brandingSettings"]);
    expect(req.requestBody.id).toBe("UC1");
    expect(req.requestBody.brandingSettings.channel).toMatchObject({
      title: "Name",
      description: "new text",
      keywords: 'x "two words"',
      country: "UA",
      showRelatedChannels: true,
    });
    expect(req.requestBody.brandingSettings.image.bannerExternalUrl).toBe("https://yt3.example/banner");
  });

  it("replaces only the banner when asked to", async () => {
    const update = vi.fn(async (req: unknown) => ({ data: req }));
    const yt = asClient({ channels: { list: async () => ({ data: { items: [current] } }), update } });
    await patchBranding(yt, { bannerExternalUrl: "https://yt3.example/new" });
    const req = update.mock.calls[0]![0] as any;
    expect(req.requestBody.brandingSettings.image.bannerExternalUrl).toBe("https://yt3.example/new");
    expect(req.requestBody.brandingSettings.channel.description).toBe("old");
  });
});

describe("listVideos", () => {
  const makeClient = () => {
    const search = vi.fn(async () => ({ data: { items: [{ id: { videoId: "v1" } }], pageInfo: { totalResults: 1 } } }));
    const playlistItems = vi.fn(async () => ({
      data: { items: [{ contentDetails: { videoId: "v1" } }, { contentDetails: { videoId: "v2" } }], pageInfo: { totalResults: 2 } },
    }));
    const channels = vi.fn(async () => ({ data: { items: [{ contentDetails: { relatedPlaylists: { uploads: "UUup" } } }] } }));
    const videos = vi.fn(async (req: { id: string[] }) => ({ data: { items: req.id.map((id) => ({ id })) } }));
    return {
      search, playlistItems, channels, videos,
      yt: asClient({ search: { list: search }, playlistItems: { list: playlistItems }, channels: { list: channels }, videos: { list: videos } }),
    };
  };

  it("lists the channel's own videos through the cheap uploads playlist (never search.list)", async () => {
    const c = makeClient();
    const r = await listVideos(c.yt, { maxResults: 10 });
    expect(c.search).not.toHaveBeenCalled();
    expect((c.playlistItems.mock.calls[0]![0] as any).playlistId).toBe("UUup");
    expect(r.items.map((v) => v.id)).toEqual(["v1", "v2"]);
    expect(r.quotaCost).toBe(3);
  });

  it("uses search (and reports its real cost) only for queries", async () => {
    const c = makeClient();
    const r = await listVideos(c.yt, { query: "cats" });
    expect(c.search).toHaveBeenCalledTimes(1);
    expect(r.quotaCost).toBe(101);
  });

  it("lists a given playlist directly", async () => {
    const c = makeClient();
    await listVideos(c.yt, { playlistId: "PL1" });
    expect(c.channels).not.toHaveBeenCalled();
    expect((c.playlistItems.mock.calls[0]![0] as any).playlistId).toBe("PL1");
  });
});

describe("publishing helpers keep the video's other status fields", () => {
  const status = { privacyStatus: "private", embeddable: false, license: "creativeCommon", publicStatsViewable: true, selfDeclaredMadeForKids: false, uploadStatus: "processed", publishAt: "2030-01-01T00:00:00Z" };
  const make = () => {
    const update = vi.fn(async (req: any) => ({ data: { id: req.requestBody.id, status: req.requestBody.status } }));
    return { update, yt: asClient({ videos: { list: async () => ({ data: { items: [{ id: "v", status }] } }), update } }) };
  };

  it("setPrivacy drops a pending schedule and read-only fields but keeps the writable ones", async () => {
    const { yt, update } = make();
    await setPrivacy(yt, "v", "public");
    const sent = (update.mock.calls[0]![0] as any).requestBody.status;
    expect(sent).toEqual({ embeddable: false, license: "creativeCommon", publicStatsViewable: true, selfDeclaredMadeForKids: false, privacyStatus: "public" });
  });

  it("schedulePublish sends private + publishAt", async () => {
    const { yt, update } = make();
    await schedulePublish(yt, "v", "2031-01-01T10:00:00Z");
    const sent = (update.mock.calls[0]![0] as any).requestBody.status;
    expect(sent.privacyStatus).toBe("private");
    expect(sent.publishAt).toBe("2031-01-01T10:00:00Z");
    expect(sent.embeddable).toBe(false);
  });

  it("reports a missing video clearly", async () => {
    const yt = asClient({ videos: { list: async () => ({ data: { items: [] } }), update: vi.fn() } });
    await expect(setPrivacy(yt, "nope", "public")).rejects.toThrow(/not found/i);
  });
});

describe("withShortsTag", () => {
  it("adds #Shorts once", () => {
    expect(withShortsTag("hello")).toBe("hello\n\n#Shorts");
    expect(withShortsTag("hello #shorts")).toBe("hello #shorts");
    expect(withShortsTag(undefined)).toBe("#Shorts");
  });
});

describe("setWatermark", () => {
  it("omits durationMs when 0 and sends the image", async () => {
    const set = vi.fn(async () => ({}));
    const yt = asClient({ watermarks: { set } });
    await setWatermark(yt, "UC1", { buffer: Buffer.from("x"), mimeType: "image/png" }, { cornerPosition: "topLeft", type: "corner" }, { type: "offsetFromStart", offsetMs: 0, durationMs: 0 });
    const req = set.mock.calls[0]![0] as any;
    expect(req.requestBody.timing).toEqual({ type: "offsetFromStart", offsetMs: "0" });
    expect(req.media.mimeType).toBe("image/png");
  });
});
