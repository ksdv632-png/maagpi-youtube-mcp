import { z } from "zod";

/**
 * Configuration is read once at start-up from environment variables.
 *
 * Two modes:
 *  - "stdio": local process spawned by an MCP client (needs YOUTUBE_CLIENT_ID/SECRET).
 *  - "http" : remote Streamable-HTTP server (Railway). Needs the extra settings listed
 *             in `getMissingRemoteSettings`. When some are missing the server still
 *             starts in "setup mode" and shows a status page instead of crashing, so
 *             the owner can fix it from a phone.
 */

const csv = (value: string | undefined): string[] =>
  (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

const flag = (value: string | undefined): boolean =>
  value !== undefined && ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());

const ConfigSchema = z.object({
  clientId: z.string().default(""),
  clientSecret: z.string().default(""),
  transport: z.enum(["stdio", "http"]).default("stdio"),
  httpPort: z.coerce.number().int().min(1).max(65535).default(3000),
  httpHost: z.string().default("127.0.0.1"),
  quotaLimit: z.coerce.number().int().positive().default(9000),
  cacheTtlOverride: z.coerce.number().int().positive().optional(),
  logLevel: z.enum(["error", "warn", "info", "debug"]).default("info"),
  nodeEnv: z.enum(["development", "production", "test"]).default("production"),

  // ── Remote (HTTP) mode only ────────────────────────────────────────────────
  publicUrl: z.string().optional(),
  tokenEncryptionKey: z.string().optional(),
  allowedEmails: z.array(z.string()).default([]),
  allowedOrigins: z.array(z.string()).default([]),
  allowedRedirectUris: z.array(z.string()).default([]),
  allowedChannelId: z.string().optional(),
  displayTimeZone: z.string().default("Europe/Kyiv"),
  uiLanguage: z.enum(["uk", "en"]).default("uk"),
  maxUploadMb: z.coerce.number().int().min(1).max(262_144).default(2048),
  allowedDownloadHosts: z.array(z.string()).default([]),
  allowDestructive: z.boolean().default(false),
});

export type Config = z.infer<typeof ConfigSchema>;

function resolvePublicUrl(env: NodeJS.ProcessEnv): string | undefined {
  const explicit = env["PUBLIC_URL"]?.trim();
  const railway = env["RAILWAY_PUBLIC_DOMAIN"]?.trim();
  const raw = explicit || (railway ? `https://${railway}` : undefined);
  return raw ? raw.replace(/\/+$/, "") : undefined;
}

export function parseConfig(env: NodeJS.ProcessEnv, argv: string[] = []): Config {
  const transport = argv.includes("--http") ? "http" : env["YOUTUBE_MCP_TRANSPORT"];
  // Railway (and most PaaS) provide PORT and need 0.0.0.0; locally keep loopback.
  const port = env["YOUTUBE_MCP_HTTP_PORT"] ?? env["PORT"];
  const host = env["YOUTUBE_MCP_HTTP_HOST"] ?? (env["PORT"] ? "0.0.0.0" : undefined);

  const result = ConfigSchema.safeParse({
    clientId: env["YOUTUBE_CLIENT_ID"],
    clientSecret: env["YOUTUBE_CLIENT_SECRET"],
    transport,
    httpPort: port,
    httpHost: host,
    quotaLimit: env["YOUTUBE_MCP_QUOTA_LIMIT"],
    cacheTtlOverride: env["YOUTUBE_MCP_CACHE_TTL"],
    logLevel: env["YOUTUBE_MCP_LOG_LEVEL"],
    nodeEnv: env["NODE_ENV"],
    publicUrl: resolvePublicUrl(env),
    tokenEncryptionKey: env["TOKEN_ENCRYPTION_KEY"]?.trim() || undefined,
    allowedEmails: csv(env["ALLOWED_GOOGLE_EMAILS"]).map((e) => e.toLowerCase()),
    allowedOrigins: csv(env["ALLOWED_ORIGINS"]),
    allowedRedirectUris: csv(env["ALLOWED_REDIRECT_URIS"]),
    allowedChannelId: env["YOUTUBE_CHANNEL_ID"]?.trim() || undefined,
    displayTimeZone: env["DISPLAY_TIMEZONE"]?.trim() || undefined,
    uiLanguage: env["UI_LANGUAGE"]?.trim() || undefined,
    maxUploadMb: env["MAX_UPLOAD_MB"],
    allowedDownloadHosts: csv(env["ALLOWED_DOWNLOAD_HOSTS"]).map((h) => h.toLowerCase()),
    allowDestructive: flag(env["YOUTUBE_MCP_ALLOW_DESTRUCTIVE"]),
  });

  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`YouTube MCP configuration error:\n${issues}`);
  }

  const cfg = result.data;
  if (cfg.transport === "stdio" && (!cfg.clientId || !cfg.clientSecret)) {
    throw new Error(
      "YouTube MCP configuration error:\n  - YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET are required"
    );
  }
  return cfg;
}

export interface MissingSetting {
  name: string;
  hint: string;
}

/** Remote mode: the settings the owner still has to provide (names only, never values). */
export function getMissingRemoteSettings(cfg: Config): MissingSetting[] {
  const missing: MissingSetting[] = [];
  if (!cfg.clientId) {
    missing.push({ name: "YOUTUBE_CLIENT_ID", hint: "Google Cloud → Credentials → OAuth client ID" });
  }
  if (!cfg.clientSecret) {
    missing.push({ name: "YOUTUBE_CLIENT_SECRET", hint: "Google Cloud → Credentials → OAuth client secret" });
  }
  if (!cfg.publicUrl) {
    missing.push({
      name: "PUBLIC_URL",
      hint: "Your Railway domain, e.g. https://my-app.up.railway.app (set automatically if a Railway domain is generated)",
    });
  } else if (!isAcceptablePublicUrl(cfg.publicUrl)) {
    missing.push({ name: "PUBLIC_URL", hint: "Must be an https:// URL (http is only allowed for localhost)" });
  }
  if (!cfg.tokenEncryptionKey || cfg.tokenEncryptionKey.length < 32) {
    missing.push({
      name: "TOKEN_ENCRYPTION_KEY",
      hint: "Random secret, at least 32 characters. Open this page again to get a generated one.",
    });
  }
  if (cfg.allowedEmails.length === 0) {
    missing.push({
      name: "ALLOWED_GOOGLE_EMAILS",
      hint: "Email of the Google account that owns the YouTube channel (comma-separated for several)",
    });
  }
  return missing;
}

export function isAcceptablePublicUrl(value: string): boolean {
  try {
    const u = new URL(value);
    if (u.search || u.hash) return false;
    if (u.protocol === "https:") return true;
    return u.protocol === "http:" && ["localhost", "127.0.0.1"].includes(u.hostname);
  } catch {
    return false;
  }
}

export const config: Config = parseConfig(process.env, process.argv.slice(2));

/** True when running as the remote Streamable-HTTP server (no local files, no local browser). */
export const isRemote = config.transport === "http";
