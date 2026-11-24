import { describe, it, expect } from "vitest";
import { ApprovalStore, sameAction, type PublishAction } from "../../../src/publishing/approvals.js";

const pub: PublishAction = { kind: "set_privacy", videoId: "vid1", privacyStatus: "public" };

describe("ApprovalStore", () => {
  it("creates unguessable ids", () => {
    const s = new ApprovalStore();
    const a = s.create("user1", pub, {});
    const b = s.create("user1", pub, {});
    expect(a.id).not.toBe(b.id);
    expect(a.id.length).toBeGreaterThanOrEqual(40);
  });

  it("cannot be claimed before the owner approved", () => {
    const s = new ApprovalStore();
    const a = s.create("user1", pub, {});
    expect(s.claim(a.id, "user1", pub)).toEqual({ ok: false, reason: "not_approved" });
  });

  it("can be claimed once after approval", () => {
    const s = new ApprovalStore();
    const a = s.create("user1", pub, {});
    expect(s.decide(a.id, "approve")?.status).toBe("approved");
    expect(s.claim(a.id, "user1", pub)).toEqual({ ok: true });
    expect(s.claim(a.id, "user1", pub)).toEqual({ ok: false, reason: "consumed" });
  });

  it("release() re-opens a claim when the YouTube call failed", () => {
    const s = new ApprovalStore();
    const a = s.create("user1", pub, {});
    s.decide(a.id, "approve");
    s.claim(a.id, "user1", pub);
    s.release(a.id);
    expect(s.claim(a.id, "user1", pub)).toEqual({ ok: true });
  });

  it("a rejection is final", () => {
    const s = new ApprovalStore();
    const a = s.create("user1", pub, {});
    s.decide(a.id, "reject");
    expect(s.claim(a.id, "user1", pub)).toEqual({ ok: false, reason: "rejected" });
    expect(s.decide(a.id, "approve")).toBeUndefined();
  });

  it("is bound to the user and to the exact action", () => {
    const s = new ApprovalStore();
    const a = s.create("user1", pub, {});
    s.decide(a.id, "approve");
    expect(s.claim(a.id, "user2", pub)).toEqual({ ok: false, reason: "mismatch" });
    expect(s.claim(a.id, "user1", { ...pub, videoId: "other" })).toEqual({ ok: false, reason: "mismatch" });
    expect(s.claim(a.id, "user1", { ...pub, privacyStatus: "unlisted" })).toEqual({ ok: false, reason: "mismatch" });
    expect(s.claim(a.id, "user1", pub)).toEqual({ ok: true });
  });

  it("expires", () => {
    let now = 1_000_000;
    const s = new ApprovalStore({ ttlMs: 60_000, now: () => now });
    const a = s.create("user1", pub, {});
    s.decide(a.id, "approve");
    now += 61_000;
    expect(s.claim(a.id, "user1", pub)).toEqual({ ok: false, reason: "expired" });
    expect(s.get(a.id)).toBeUndefined();
  });

  it("unknown ids are not found", () => {
    expect(new ApprovalStore().claim("nope", "user1", pub)).toEqual({ ok: false, reason: "not_found" });
  });

  it("limits pending approvals per user", () => {
    const s = new ApprovalStore({ maxPerPrincipal: 3 });
    for (let i = 0; i < 10; i++) s.create("user1", { ...pub, videoId: `v${i}` }, {});
    expect(s.size()).toBe(3);
  });
});

describe("sameAction", () => {
  it("compares schedule times as instants", () => {
    const a: PublishAction = { kind: "schedule", videoId: "v", publishAt: "2030-01-01T10:00:00+02:00" };
    const b: PublishAction = { kind: "schedule", videoId: "v", publishAt: "2030-01-01T08:00:00Z" };
    expect(sameAction(a, b)).toBe(true);
    expect(sameAction(a, { ...b, publishAt: "2030-01-01T09:00:00Z" } as PublishAction)).toBe(false);
    expect(sameAction(a, pub)).toBe(false);
  });
});
