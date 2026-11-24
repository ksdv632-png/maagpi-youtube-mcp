import { describe, it, expect } from "vitest";
import { SchedulePublishSchema, SetPrivacySchema } from "../../../src/schemas/publishing.js";

describe("SchedulePublishSchema", () => {
  it("accepts a future ISO datetime", () => {
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    expect(SchedulePublishSchema.safeParse({ videoId: "abc", publishAt: future }).success).toBe(true);
  });

  it("rejects a past datetime", () => {
    const past = new Date(Date.now() - 1000).toISOString();
    expect(SchedulePublishSchema.safeParse({ videoId: "abc", publishAt: past }).success).toBe(false);
  });

  it("rejects invalid datetime format", () => {
    expect(SchedulePublishSchema.safeParse({ videoId: "abc", publishAt: "2024-13-01" }).success).toBe(false);
  });

  it("requires a time-zone offset", () => {
    expect(SchedulePublishSchema.safeParse({ videoId: "abc", publishAt: "2999-01-01T10:00:00" }).success).toBe(false);
  });
});

describe("SetPrivacySchema", () => {
  it("accepts a publish confirmation (local mode)", () => {
    expect(
      SetPrivacySchema.safeParse({ videoId: "abc", privacyStatus: "public", confirmPublish: true }).success
    ).toBe(true);
  });

  it("rejects unknown privacy values", () => {
    expect(SetPrivacySchema.safeParse({ videoId: "abc", privacyStatus: "friends" }).success).toBe(false);
  });
});
