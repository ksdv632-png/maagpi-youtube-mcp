import { describe, it, expect } from "vitest";
import { normalizeCloudUrl, CloudUrlError } from "../../../src/net/cloud-url.js";

describe("normalizeCloudUrl", () => {
  it("converts Dropbox share links to direct downloads", () => {
    const out = new URL(normalizeCloudUrl("https://www.dropbox.com/scl/fi/abc/clip.mp4?rlkey=xyz&dl=0"));
    expect(out.hostname).toBe("www.dropbox.com");
    expect(out.searchParams.get("dl")).toBe("1");
    expect(out.searchParams.get("rlkey")).toBe("xyz");
  });

  it("converts Google Drive file links", () => {
    const out = new URL(normalizeCloudUrl("https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQr/view?usp=sharing"));
    expect(out.hostname).toBe("drive.usercontent.google.com");
    expect(out.searchParams.get("id")).toBe("1AbCdEfGhIjKlMnOpQr");
    expect(out.searchParams.get("export")).toBe("download");
  });

  it("converts Google Drive open?id= links", () => {
    const out = new URL(normalizeCloudUrl("https://drive.google.com/open?id=1AbCdEfGhIjKlMnOpQr"));
    expect(out.searchParams.get("id")).toBe("1AbCdEfGhIjKlMnOpQr");
  });

  it("rejects Drive folders and iCloud with a helpful message", () => {
    expect(() => normalizeCloudUrl("https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOpQr")).toThrow(CloudUrlError);
    expect(() => normalizeCloudUrl("https://www.icloud.com/iclouddrive/abc")).toThrow(/iCloud/);
  });

  it("leaves other links (pre-signed URLs etc.) untouched", () => {
    const url = "https://bucket.s3.amazonaws.com/v.mp4?X-Amz-Signature=abc";
    expect(normalizeCloudUrl(url)).toBe(url);
  });

  it("rejects garbage", () => {
    expect(() => normalizeCloudUrl("not a url")).toThrow(CloudUrlError);
  });
});
