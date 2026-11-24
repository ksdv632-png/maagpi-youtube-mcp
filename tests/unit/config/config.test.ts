import { describe, it, expect } from "vitest";
import { getMissingRemoteSettings, isAcceptablePublicUrl, parseConfig } from "../../../src/config.js";

describe("parseConfig", () => {
  it("stdio mode requires the Google client", () => {
    expect(() => parseConfig({})).toThrow(/YOUTUBE_CLIENT_ID/);
    expect(parseConfig({ YOUTUBE_CLIENT_ID: "a", YOUTUBE_CLIENT_SECRET: "b" }).transport).toBe("stdio");
  });

  it("--http starts the remote server even with nothing configured (setup mode)", () => {
    const cfg = parseConfig({}, ["--http"]);
    expect(cfg.transport).toBe("http");
    expect(getMissingRemoteSettings(cfg).map((m) => m.name)).toEqual([
      "YOUTUBE_CLIENT_ID", "YOUTUBE_CLIENT_SECRET", "PUBLIC_URL", "TOKEN_ENCRYPTION_KEY", "ALLOWED_GOOGLE_EMAILS",
    ]);
  });

  it("uses Railway's PORT and binds 0.0.0.0 when PORT is set; derives PUBLIC_URL from the Railway domain", () => {
    const cfg = parseConfig({ PORT: "8080", RAILWAY_PUBLIC_DOMAIN: "app.up.railway.app" }, ["--http"]);
    expect(cfg.httpPort).toBe(8080);
    expect(cfg.httpHost).toBe("0.0.0.0");
    expect(cfg.publicUrl).toBe("https://app.up.railway.app");
  });

  it("explicit PUBLIC_URL wins and loses its trailing slash; emails are normalised", () => {
    const cfg = parseConfig({ PUBLIC_URL: "https://x.example.com/", ALLOWED_GOOGLE_EMAILS: " A@B.com , c@d.com " }, ["--http"]);
    expect(cfg.publicUrl).toBe("https://x.example.com");
    expect(cfg.allowedEmails).toEqual(["a@b.com", "c@d.com"]);
  });

  it("destructive tools are off unless explicitly enabled", () => {
    expect(parseConfig({}, ["--http"]).allowDestructive).toBe(false);
    expect(parseConfig({ YOUTUBE_MCP_ALLOW_DESTRUCTIVE: "true" }, ["--http"]).allowDestructive).toBe(true);
  });

  it("flags short encryption keys and insecure public URLs as missing", () => {
    const base = { YOUTUBE_CLIENT_ID: "a", YOUTUBE_CLIENT_SECRET: "b", ALLOWED_GOOGLE_EMAILS: "a@b.com" };
    const short = parseConfig({ ...base, PUBLIC_URL: "https://x.example.com", TOKEN_ENCRYPTION_KEY: "short" }, ["--http"]);
    expect(getMissingRemoteSettings(short).map((m) => m.name)).toEqual(["TOKEN_ENCRYPTION_KEY"]);
    const http = parseConfig({ ...base, PUBLIC_URL: "http://x.example.com", TOKEN_ENCRYPTION_KEY: "k".repeat(40) }, ["--http"]);
    expect(getMissingRemoteSettings(http).map((m) => m.name)).toEqual(["PUBLIC_URL"]);
    const ok = parseConfig({ ...base, PUBLIC_URL: "https://x.example.com", TOKEN_ENCRYPTION_KEY: "k".repeat(40) }, ["--http"]);
    expect(getMissingRemoteSettings(ok)).toEqual([]);
  });
});

describe("isAcceptablePublicUrl", () => {
  it("allows https and loopback http only", () => {
    expect(isAcceptablePublicUrl("https://a.example.com")).toBe(true);
    expect(isAcceptablePublicUrl("http://localhost:3000")).toBe(true);
    expect(isAcceptablePublicUrl("http://a.example.com")).toBe(false);
    expect(isAcceptablePublicUrl("https://a.example.com/?x=1")).toBe(false);
    expect(isAcceptablePublicUrl("nonsense")).toBe(false);
  });
});
