import https from "node:https";
import type { IncomingMessage } from "node:http";
import { Readable, Transform, type TransformCallback } from "node:stream";
import { YouTubeMcpError } from "../errors/types.js";
import { YouTubeMcpErrorCode } from "../errors/codes.js";
import { normalizeCloudUrl, CloudUrlError } from "./cloud-url.js";
import { createGuardedLookup, isBlockedHostname, isBlockedIp } from "./ip-guard.js";
import net from "node:net";

export type MediaKind = "video" | "image";

export type Requester = (
  url: URL,
  opts: { lookup: net.LookupFunction; timeoutMs: number }
) => Promise<IncomingMessage>;

export interface DownloadOptions {
  maxBytes: number;
  kind: MediaKind;
  /** If non-empty the *first* URL must be on one of these hosts (or a subdomain). */
  allowedHosts?: string[];
  timeoutMs?: number;
  maxRedirects?: number;
  requester?: Requester;
}

export interface DownloadResult {
  /** Body stream, already validated (magic bytes) and size-limited. */
  stream: Readable;
  contentLength?: number;
  /** Mime type derived from the file's magic bytes (not from the server's header). */
  mimeType: string;
  finalHost: string;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function fail(message: string, code = YouTubeMcpErrorCode.DOWNLOAD_FAILED): never {
  throw new YouTubeMcpError(code, message, { retryable: false });
}

/** Validate a URL before any network access. Throws YouTubeMcpError. */
export function assertDownloadUrl(url: URL, allowedHosts: string[] = []): void {
  if (url.protocol !== "https:") fail("Only https:// links are accepted.");
  if (url.username || url.password) fail("Links with embedded credentials are not accepted.");
  if (url.port && url.port !== "443") fail("Only the standard https port (443) is accepted.");
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host) fail("The link has no host name.");
  if (net.isIP(host)) {
    if (isBlockedIp(host)) fail("This address is not allowed (private or reserved network).");
  } else if (isBlockedHostname(host)) {
    fail("This host name is not allowed (local or internal network).");
  }
  if (allowedHosts.length > 0) {
    const ok = allowedHosts.some((h) => host === h || host.endsWith(`.${h}`));
    if (!ok) fail(`This host is not on the allowed download hosts list (ALLOWED_DOWNLOAD_HOSTS).`);
  }
}

const defaultRequester: Requester = (url, { lookup, timeoutMs }) =>
  new Promise<IncomingMessage>((resolve, reject) => {
    const req = https.request(
      url,
      {
        method: "GET",
        lookup,
        timeout: timeoutMs,
        headers: {
          "User-Agent": "maagpi-youtube-mcp/1",
          Accept: "*/*",
          "Accept-Encoding": "identity",
        },
      },
      resolve
    );
    req.on("timeout", () => req.destroy(new Error("The download server did not respond in time.")));
    req.on("error", reject);
    req.end();
  });

/** Reads at least `n` bytes from the front of a paused stream and puts them back. */
export async function peekHead(stream: Readable, n: number): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    let acc = Buffer.alloc(0);
    const cleanup = (): void => {
      stream.off("readable", onReadable);
      stream.off("end", onEnd);
      stream.off("error", onError);
    };
    const onError = (err: Error): void => {
      cleanup();
      reject(err);
    };
    const onEnd = (): void => {
      cleanup();
      resolve(acc);
    };
    const onReadable = (): void => {
      let chunk: Buffer | null;
      while ((chunk = stream.read() as Buffer | null) !== null) {
        acc = Buffer.concat([acc, chunk]);
        if (acc.length >= n) {
          cleanup();
          stream.unshift(acc);
          resolve(acc);
          return;
        }
      }
    };
    stream.on("readable", onReadable);
    stream.once("end", onEnd);
    stream.once("error", onError);
    onReadable();
  });
}

export function sniffVideo(head: Buffer): string | undefined {
  if (head.length >= 12 && head.subarray(4, 8).toString("latin1") === "ftyp") {
    return head.subarray(8, 12).toString("latin1") === "qt  " ? "video/quicktime" : "video/mp4";
  }
  if (head.length >= 4 && head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) {
    return "video/webm";
  }
  return undefined;
}

export function sniffImage(head: Buffer): string | undefined {
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "image/jpeg";
  if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (head.length >= 4 && head.subarray(0, 4).toString("latin1") === "GIF8") return "image/gif";
  return undefined;
}

/** Counts bytes and aborts the pipeline when more than `limit` bytes arrive. */
export class ByteLimiter extends Transform {
  bytes = 0;
  constructor(
    private readonly limit: number,
    private readonly onBytes?: (total: number) => void
  ) {
    super();
  }
  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    this.bytes += chunk.length;
    if (this.bytes > this.limit) {
      cb(
        new YouTubeMcpError(
          YouTubeMcpErrorCode.FILE_TOO_LARGE,
          `The file is larger than the allowed maximum of ${Math.round(this.limit / 1024 / 1024)} MB.`
        )
      );
      return;
    }
    this.onBytes?.(this.bytes);
    cb(null, chunk);
  }
}

/**
 * Opens a download from a (cloud-storage) URL with SSRF protection:
 * https only, public addresses only (checked at connect time), manual redirects that are
 * re-validated on every hop, size limit, HTML pages rejected, file type verified by magic bytes.
 */
export async function openDownload(rawUrl: string, opts: DownloadOptions): Promise<DownloadResult> {
  let url: URL;
  try {
    url = new URL(normalizeCloudUrl(rawUrl));
  } catch (err) {
    if (err instanceof CloudUrlError) fail(err.message);
    fail("The link is not a valid URL.");
  }
  const requester = opts.requester ?? defaultRequester;
  const lookup = createGuardedLookup();
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const maxRedirects = opts.maxRedirects ?? 5;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    assertDownloadUrl(url, hop === 0 ? opts.allowedHosts : []);
    let res: IncomingMessage;
    try {
      res = await requester(url, { lookup, timeoutMs });
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "EBLOCKED") fail("This host resolves to a private or reserved address and is not allowed.");
      fail(`Could not download the file: ${e.message || "network error"}`);
    }

    const status = res.statusCode ?? 0;
    if (REDIRECT_STATUSES.has(status)) {
      res.resume();
      const location = res.headers.location;
      if (!location) fail("The server redirected without a Location header.");
      try {
        url = new URL(location, url);
      } catch {
        fail("The server redirected to an invalid URL.");
      }
      continue;
    }
    if (status !== 200) {
      res.resume();
      fail(
        status === 401 || status === 403 || status === 404
          ? `The link is not accessible (HTTP ${status}). Make sure sharing is set to "Anyone with the link".`
          : `The download server answered HTTP ${status}.`
      );
    }

    const type = String(res.headers["content-type"] ?? "").toLowerCase();
    if (type.startsWith("text/html")) {
      res.resume();
      fail(
        "The link opens a web page, not a file. Use a direct download link (for Google Drive/Dropbox: share as 'Anyone with the link').",
        YouTubeMcpErrorCode.UNSUPPORTED_MEDIA
      );
    }
    const lengthHeader = Number(res.headers["content-length"]);
    const contentLength = Number.isFinite(lengthHeader) && lengthHeader > 0 ? lengthHeader : undefined;
    if (contentLength !== undefined && contentLength > opts.maxBytes) {
      res.resume();
      fail(
        `The file is ${Math.round(contentLength / 1024 / 1024)} MB, larger than the allowed maximum of ${Math.round(
          opts.maxBytes / 1024 / 1024
        )} MB.`,
        YouTubeMcpErrorCode.FILE_TOO_LARGE
      );
    }

    let head: Buffer;
    try {
      head = await peekHead(res, 16);
    } catch (err) {
      fail(`Could not read the file: ${(err as Error).message}`);
    }
    const mimeType = opts.kind === "video" ? sniffVideo(head) : sniffImage(head);
    if (!mimeType) {
      res.destroy();
      fail(
        opts.kind === "video"
          ? "The file is not a supported video (MP4/MOV/WebM expected)."
          : "The file is not a supported image (JPEG/PNG/GIF expected).",
        YouTubeMcpErrorCode.UNSUPPORTED_MEDIA
      );
    }
    return { stream: res, contentLength, mimeType, finalHost: url.hostname };
  }
  return fail("Too many redirects.");
}

/** Downloads a small file (image) fully into memory. */
export async function downloadToBuffer(
  rawUrl: string,
  opts: Omit<DownloadOptions, "kind"> & { kind?: MediaKind }
): Promise<{ buffer: Buffer; mimeType: string }> {
  const result = await openDownload(rawUrl, { kind: "image", ...opts });
  const chunks: Buffer[] = [];
  const limiter = new ByteLimiter(opts.maxBytes);
  try {
    await new Promise<void>((resolve, reject) => {
      result.stream.on("error", reject);
      limiter.on("error", reject);
      limiter.on("data", (c: Buffer) => chunks.push(c));
      limiter.on("end", resolve);
      result.stream.pipe(limiter);
    });
  } catch (err) {
    result.stream.destroy();
    if (err instanceof YouTubeMcpError) throw err;
    fail(`Could not download the file: ${(err as Error).message}`);
  }
  return { buffer: Buffer.concat(chunks), mimeType: result.mimeType };
}
