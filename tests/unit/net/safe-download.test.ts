import { describe, it, expect } from "vitest";
import { Readable } from "node:stream";
import type { IncomingMessage } from "node:http";
import {
  assertDownloadUrl, openDownload, downloadToBuffer, sniffImage, sniffVideo, ByteLimiter,
  type Requester,
} from "../../../src/net/safe-download.js";
import { YouTubeMcpError } from "../../../src/errors/types.js";

const MP4_HEAD = Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from("ftypisom"), Buffer.alloc(40)]);
const PNG_HEAD = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(20)]);

function response(status: number, headers: Record<string, string>, body: Buffer = Buffer.alloc(0)): IncomingMessage {
  const stream = Readable.from([body]) as unknown as IncomingMessage;
  stream.statusCode = status;
  stream.headers = headers;
  return stream;
}

const scripted = (steps: Array<(url: URL) => IncomingMessage>): { requester: Requester; seen: string[] } => {
  const seen: string[] = [];
  let i = 0;
  return {
    seen,
    requester: async (url) => {
      seen.push(url.toString());
      const step = steps[Math.min(i++, steps.length - 1)]!;
      return step(url);
    },
  };
};

describe("assertDownloadUrl", () => {
  const bad = (u: string, hosts?: string[]) => () => assertDownloadUrl(new URL(u), hosts);
  it("only accepts plain https on 443", () => {
    expect(bad("http://example.com/a.mp4")).toThrow(/https/);
    expect(bad("ftp://example.com/a.mp4")).toThrow();
    expect(bad("https://example.com:8443/a.mp4")).toThrow(/443/);
    expect(bad("https://user:pw@example.com/a.mp4")).toThrow(/credentials/);
    expect(bad("https://example.com/a.mp4")).not.toThrow();
  });
  it("blocks private/loopback/metadata targets", () => {
    for (const u of [
      "https://127.0.0.1/x", "https://[::1]/x", "https://10.0.0.1/x", "https://169.254.169.254/latest/meta-data",
      "https://localhost/x", "https://api.railway.internal/x", "https://[::ffff:127.0.0.1]/x",
    ]) {
      expect(bad(u), u).toThrow();
    }
  });
  it("honours an allow-list (host or subdomain)", () => {
    expect(bad("https://evil.example/a.mp4", ["drive.google.com"])).toThrow(/allowed/);
    expect(bad("https://drive.google.com/a", ["drive.google.com"])).not.toThrow();
    expect(bad("https://x.dropbox.com/a", ["dropbox.com"])).not.toThrow();
  });
});

describe("magic-byte sniffing", () => {
  it("recognises mp4/mov/webm and rejects others", () => {
    expect(sniffVideo(MP4_HEAD)).toBe("video/mp4");
    expect(sniffVideo(Buffer.concat([Buffer.from([0, 0, 0, 0x14]), Buffer.from("ftypqt  ")]))).toBe("video/quicktime");
    expect(sniffVideo(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe("video/webm");
    expect(sniffVideo(Buffer.from("<html><body>login</body></html>"))).toBeUndefined();
    expect(sniffVideo(Buffer.from("MZ executable"))).toBeUndefined();
  });
  it("recognises images", () => {
    expect(sniffImage(PNG_HEAD)).toBe("image/png");
    expect(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniffImage(Buffer.from("GIF89a"))).toBe("image/gif");
    expect(sniffImage(MP4_HEAD)).toBeUndefined();
  });
});

describe("openDownload", () => {
  it("downloads a valid mp4", async () => {
    const { requester } = scripted([() => response(200, { "content-type": "video/mp4", "content-length": String(MP4_HEAD.length) }, MP4_HEAD)]);
    const dl = await openDownload("https://files.example.com/v.mp4", { kind: "video", maxBytes: 1_000_000, requester });
    const chunks: Buffer[] = [];
    for await (const c of dl.stream) chunks.push(c as Buffer);
    expect(Buffer.concat(chunks).equals(MP4_HEAD)).toBe(true);
    expect(dl.mimeType).toBe("video/mp4");
  });

  it("follows redirects but re-validates every hop (redirect to an internal address is refused)", async () => {
    const { requester, seen } = scripted([
      () => response(302, { location: "https://cdn.example.com/real.mp4" }),
      () => response(302, { location: "https://169.254.169.254/latest/meta-data/" }),
    ]);
    await expect(
      openDownload("https://files.example.com/v.mp4", { kind: "video", maxBytes: 1e6, requester })
    ).rejects.toThrow(/not allowed|private/i);
    expect(seen).toEqual(["https://files.example.com/v.mp4", "https://cdn.example.com/real.mp4"]);
  });

  it("refuses redirects to plain http", async () => {
    const { requester } = scripted([() => response(301, { location: "http://cdn.example.com/v.mp4" })]);
    await expect(openDownload("https://files.example.com/v.mp4", { kind: "video", maxBytes: 1e6, requester })).rejects.toThrow(/https/);
  });

  it("stops after too many redirects", async () => {
    const { requester } = scripted([() => response(302, { location: "https://files.example.com/loop" })]);
    await expect(
      openDownload("https://files.example.com/v.mp4", { kind: "video", maxBytes: 1e6, requester, maxRedirects: 3 })
    ).rejects.toThrow(/redirects/);
  });

  it("rejects HTML pages (e.g. a login or share page)", async () => {
    const { requester } = scripted([() => response(200, { "content-type": "text/html; charset=utf-8" }, Buffer.from("<html>"))]);
    await expect(openDownload("https://files.example.com/v", { kind: "video", maxBytes: 1e6, requester })).rejects.toThrow(/web page/);
  });

  it("rejects files that are not videos, whatever the server claims", async () => {
    const { requester } = scripted([() => response(200, { "content-type": "video/mp4" }, Buffer.from("MZ not a video at all, sorry"))]);
    await expect(openDownload("https://files.example.com/v.mp4", { kind: "video", maxBytes: 1e6, requester })).rejects.toThrow(/not a supported video/);
  });

  it("rejects files larger than the limit by Content-Length, before reading", async () => {
    const { requester } = scripted([() => response(200, { "content-length": "999999999999" }, MP4_HEAD)]);
    await expect(openDownload("https://files.example.com/v.mp4", { kind: "video", maxBytes: 1e6, requester })).rejects.toThrow(/larger than/);
  });

  it("explains 403/404 as a sharing problem", async () => {
    const { requester } = scripted([() => response(403, {})]);
    await expect(openDownload("https://files.example.com/v.mp4", { kind: "video", maxBytes: 1e6, requester })).rejects.toThrow(/Anyone with the link/);
  });

  it("errors are YouTubeMcpErrors with a stable code", async () => {
    await expect(openDownload("http://files.example.com/v.mp4", { kind: "video", maxBytes: 1e6 })).rejects.toBeInstanceOf(YouTubeMcpError);
  });
});

describe("ByteLimiter / downloadToBuffer", () => {
  it("aborts when the stream exceeds the limit (no Content-Length)", async () => {
    const big = Buffer.concat([PNG_HEAD, Buffer.alloc(5000)]);
    const { requester } = scripted([() => response(200, {}, big)]);
    await expect(downloadToBuffer("https://img.example.com/a.png", { maxBytes: 1000, requester })).rejects.toThrow(/larger than/);
  });

  it("returns the image bytes and detected type", async () => {
    const { requester } = scripted([() => response(200, {}, PNG_HEAD)]);
    const r = await downloadToBuffer("https://img.example.com/a.png", { maxBytes: 1e6, requester });
    expect(r.mimeType).toBe("image/png");
    expect(r.buffer.equals(PNG_HEAD)).toBe(true);
  });

  it("ByteLimiter reports progress", async () => {
    const seen: number[] = [];
    const limiter = new ByteLimiter(100, (n) => seen.push(n));
    await new Promise<void>((resolve, reject) => {
      limiter.on("data", () => undefined).on("end", resolve).on("error", reject);
      limiter.write(Buffer.alloc(10));
      limiter.end(Buffer.alloc(20));
    });
    expect(seen).toEqual([10, 30]);
  });
});
