import { describe, it, expect } from "vitest";
import { TokenCrypto, safeEqual } from "../../../src/remote/crypto.js";

const KEY = "k".repeat(40);

describe("TokenCrypto", () => {
  it("round-trips a payload", () => {
    const c = new TokenCrypto(KEY);
    const token = c.seal("at", { sub: "123", rt: "secret-refresh-token" }, 60);
    const opened = c.open<{ sub: string; rt: string }>("at", token);
    expect(opened?.sub).toBe("123");
    expect(opened?.rt).toBe("secret-refresh-token");
  });

  it("does not leak the payload in the token text", () => {
    const token = new TokenCrypto(KEY).seal("at", { rt: "super-secret-value" }, 60);
    expect(token).not.toContain("super-secret-value");
    expect(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8")).not.toContain("super-secret-value");
  });

  it("rejects a token of another purpose (no cross-use of refresh/access/code)", () => {
    const c = new TokenCrypto(KEY);
    const token = c.seal("rt", { sub: "1" }, 60);
    expect(c.open("at", token)).toBeNull();
    expect(c.open("code", token)).toBeNull();
  });

  it("rejects tampered tokens", () => {
    const c = new TokenCrypto(KEY);
    const token = c.seal("at", { sub: "1" }, 60);
    const flipped = token.slice(0, -2) + (token.endsWith("A") ? "B" : "A") + token.slice(-1);
    expect(c.open("at", flipped)).toBeNull();
    expect(c.open("at", "v1.")).toBeNull();
    expect(c.open("at", "garbage")).toBeNull();
    expect(c.open("at", "")).toBeNull();
  });

  it("rejects tokens sealed with a different key", () => {
    const token = new TokenCrypto(KEY).seal("at", { sub: "1" }, 60);
    expect(new TokenCrypto("z".repeat(40)).open("at", token)).toBeNull();
  });

  it("enforces expiry", () => {
    const c = new TokenCrypto(KEY);
    const now = Date.now();
    const token = c.seal("at", { sub: "1" }, 60, now);
    expect(c.open("at", token, now + 30_000)).not.toBeNull();
    expect(c.open("at", token, now + 61_000)).toBeNull();
  });

  it("refuses short keys", () => {
    expect(() => new TokenCrypto("short")).toThrow();
  });

  it("safeEqual compares strings in constant time semantics", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
  });
});
