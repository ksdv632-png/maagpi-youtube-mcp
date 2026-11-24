import { describe, it, expect } from "vitest";
import {
  UploadVideoSchema, GetVideoSchema, UpdateVideoSchema,
} from "../../../src/schemas/videos.js";

describe("UploadVideoSchema", () => {
  it("accepts a cloud link and defaults to a private, non-Short upload", () => {
    const result = UploadVideoSchema.safeParse({
      filePath: "/tmp/video.mp4",
      sourceUrl: "https://example.com/video.mp4",
      title: "My Video",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.isShort).toBe(false);
      expect(result.data.madeForKids).toBe(false);
    }
  });

  it("rejects non-https links", () => {
    const result = UploadVideoSchema.safeParse({ sourceUrl: "http://example.com/v.mp4", title: "T" });
    expect(result.success).toBe(false);
  });

  it("rejects title over 100 chars", () => {
    const result = UploadVideoSchema.safeParse({
      sourceUrl: "https://example.com/v.mp4",
      title: "x".repeat(101),
    });
    expect(result.success).toBe(false);
  });

  it("refuses to upload anything but private", () => {
    for (const privacyStatus of ["public", "unlisted"]) {
      const result = UploadVideoSchema.safeParse({
        sourceUrl: "https://example.com/v.mp4",
        title: "Test",
        privacyStatus,
      });
      expect(result.success).toBe(false);
    }
    expect(
      UploadVideoSchema.safeParse({ sourceUrl: "https://example.com/v.mp4", title: "T", privacyStatus: "private" }).success
    ).toBe(true);
  });
});

describe("GetVideoSchema", () => {
  it("accepts videoId only", () => {
    expect(GetVideoSchema.safeParse({ videoId: "abc123" }).success).toBe(true);
  });
});

describe("UpdateVideoSchema", () => {
  it("accepts partial updates", () => {
    expect(UpdateVideoSchema.safeParse({ videoId: "abc", title: "New title" }).success).toBe(true);
  });

  it("requires videoId", () => {
    expect(UpdateVideoSchema.safeParse({ title: "No ID" }).success).toBe(false);
  });
});
