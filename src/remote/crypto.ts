import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

/**
 * Stateless, authenticated, purpose-bound tokens.
 *
 * Everything the remote server hands out (OAuth client ids, authorization codes,
 * access/refresh tokens, the Google `state` parameter, CSRF tokens) is an
 * AES-256-GCM sealed JSON payload. The server therefore needs no database or
 * volume: the only secret is TOKEN_ENCRYPTION_KEY (an environment variable).
 *
 *  - A separate key is derived (HKDF-SHA256) for every `purpose`, and the purpose is
 *    also bound as AAD, so a token of one kind can never be replayed as another kind.
 *  - Every payload carries `exp` (unix seconds) which is enforced on open().
 */

const VERSION = "v1";
const IV_BYTES = 12;
const TAG_BYTES = 16;

export const b64url = {
  encode: (buf: Buffer): string => buf.toString("base64url"),
  decode: (value: string): Buffer => Buffer.from(value, "base64url"),
};

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export type Sealed<T extends object> = T & { exp: number; iat: number };

export class TokenCrypto {
  private readonly master: Buffer;
  private readonly keys = new Map<string, Buffer>();

  constructor(secret: string) {
    if (secret.length < 32) {
      throw new Error("TOKEN_ENCRYPTION_KEY must be at least 32 characters long.");
    }
    this.master = Buffer.from(secret, "utf8");
  }

  private key(purpose: string): Buffer {
    let key = this.keys.get(purpose);
    if (!key) {
      key = Buffer.from(
        hkdfSync("sha256", this.master, Buffer.from("maagpi-youtube-mcp"), `purpose:${purpose}`, 32)
      );
      this.keys.set(purpose, key);
    }
    return key;
  }

  seal<T extends object>(purpose: string, payload: T, ttlSeconds: number, nowMs = Date.now()): string {
    const iat = Math.floor(nowMs / 1000);
    const body = Buffer.from(JSON.stringify({ ...payload, iat, exp: iat + ttlSeconds }), "utf8");
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.key(purpose), iv);
    cipher.setAAD(Buffer.from(purpose, "utf8"));
    const ct = Buffer.concat([cipher.update(body), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${VERSION}.${b64url.encode(Buffer.concat([iv, tag, ct]))}`;
  }

  /** Returns the payload, or null when the token is malformed, tampered, of another purpose or expired. */
  open<T extends object>(purpose: string, token: string, nowMs = Date.now()): Sealed<T> | null {
    if (typeof token !== "string" || token.length > 8192 || !token.startsWith(`${VERSION}.`)) return null;
    try {
      const raw = b64url.decode(token.slice(VERSION.length + 1));
      if (raw.length < IV_BYTES + TAG_BYTES + 2) return null;
      const iv = raw.subarray(0, IV_BYTES);
      const tag = raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
      const ct = raw.subarray(IV_BYTES + TAG_BYTES);
      const decipher = createDecipheriv("aes-256-gcm", this.key(purpose), iv);
      decipher.setAAD(Buffer.from(purpose, "utf8"));
      decipher.setAuthTag(tag);
      const plain = Buffer.concat([decipher.update(ct), decipher.final()]);
      const payload = JSON.parse(plain.toString("utf8")) as Sealed<T>;
      if (typeof payload.exp !== "number" || payload.exp * 1000 <= nowMs) return null;
      return payload;
    } catch {
      return null;
    }
  }

  /** Deterministic keyed hash (hex), e.g. for derived client secrets. */
  mac(purpose: string, data: string): string {
    return createHmac("sha256", this.key(`mac:${purpose}`)).update(data).digest("hex");
  }
}
