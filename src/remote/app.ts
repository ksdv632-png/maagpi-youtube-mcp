import express, { type NextFunction, type Request, type Response } from "express";
import { rateLimit } from "express-rate-limit";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { getMissingRemoteSettings, type Config } from "../config.js";
import { runWithPrincipal } from "../auth/context.js";
import { approvals } from "../publishing/approvals.js";
import { logger } from "../logger.js";
import { TokenCrypto, randomToken } from "./crypto.js";
import { createGoogleOAuth, type GoogleOAuth } from "./google.js";
import {
  GOOGLE_CALLBACK_PATH,
  GoogleBackedOAuthProvider,
  OUR_SCOPE,
  principalFromAuth,
} from "./oauth-provider.js";
import { approvalPage, approvalResultPage, errorPage, statusPage, strings, type ApprovalView } from "./pages.js";

export type RemoteConfig = Pick<
  Config,
  | "clientId"
  | "clientSecret"
  | "publicUrl"
  | "tokenEncryptionKey"
  | "allowedEmails"
  | "allowedOrigins"
  | "allowedRedirectUris"
  | "allowedChannelId"
  | "displayTimeZone"
  | "uiLanguage"
>;

export interface RemoteAppOptions {
  config: RemoteConfig;
  /** A fresh MCP server (all tools registered) for every request. */
  createMcpServer: () => McpServer;
  /** Injectable for tests. */
  google?: GoogleOAuth;
}

const DEFAULT_ALLOWED_ORIGINS = ["https://claude.ai", "https://claude.com"];

const HTML_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src https://i.ytimg.com https://*.ytimg.com; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

function jsonRpcError(res: Response, status: number, code: number, message: string): void {
  res.status(status).json({ jsonrpc: "2.0", error: { code, message }, id: null });
}

function formatLocal(iso: string, timeZone: string, lang: "uk" | "en"): string {
  try {
    return new Intl.DateTimeFormat(lang === "uk" ? "uk-UA" : "en-GB", {
      dateStyle: "full",
      timeStyle: "short",
      timeZone,
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

export function createRemoteApp(opts: RemoteAppOptions): express.Express {
  const cfg = opts.config;
  const lang = cfg.uiLanguage;
  const s = strings(lang);

  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1); // Railway terminates TLS in front of the container

  const secureTransport = !!cfg.publicUrl?.startsWith("https:");
  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    if (secureTransport) res.setHeader("Strict-Transport-Security", "max-age=31536000");
    next();
  });

  app.get("/health", (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json({ status: "ok" });
  });

  const missing = getMissingRemoteSettings(cfg as Config);

  // ── Status / setup page (never shows secret values) ─────────────────────────
  app.get("/", (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Security-Policy", HTML_CSP);
    const base = cfg.publicUrl ?? `${req.protocol}://${req.get("host") ?? ""}`;
    const keyMissing = !cfg.tokenEncryptionKey || cfg.tokenEncryptionKey.length < 32;
    res
      .type("html")
      .send(
        statusPage(lang, {
          missing,
          connectorUrl: `${base}/mcp`,
          redirectUri: `${base}${GOOGLE_CALLBACK_PATH}`,
          generatedKey: keyMissing ? randomToken(48) : undefined,
        })
      );
  });

  if (missing.length > 0) {
    // Setup mode: nothing else is served until the owner has finished the configuration.
    logger.warn(`Remote server is in setup mode. Missing settings: ${missing.map((m) => m.name).join(", ")}`);
    app.use((_req, res) => {
      res.status(503).json({ error: "server_not_configured", missing: missing.map((m) => m.name) });
    });
    return app;
  }

  const publicUrl = cfg.publicUrl as string;
  const crypto = new TokenCrypto(cfg.tokenEncryptionKey as string);
  const google = opts.google ?? createGoogleOAuth({ clientId: cfg.clientId, clientSecret: cfg.clientSecret });
  const provider = new GoogleBackedOAuthProvider({
    crypto,
    google,
    publicUrl,
    allowedEmails: cfg.allowedEmails,
    allowedChannelId: cfg.allowedChannelId,
    extraRedirectUris: cfg.allowedRedirectUris,
    lang,
  });

  // ── OAuth 2.1 authorization server for Claude (+ discovery metadata) ───────
  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl: new URL(publicUrl),
      baseUrl: new URL(publicUrl),
      resourceServerUrl: provider.resourceUrl,
      scopesSupported: [OUR_SCOPE],
      resourceName: "YouTube channel manager",
    })
  );

  // Some clients look for the protected-resource metadata at the host root instead of the path-specific URL.
  app.get("/.well-known/oauth-protected-resource", (_req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.json({
      resource: provider.resourceUrl.href,
      authorization_servers: [new URL(publicUrl).href],
      scopes_supported: [OUR_SCOPE],
      resource_name: "YouTube channel manager",
    });
  });

  const pageLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 60, standardHeaders: true, legacyHeaders: false });

  app.get(GOOGLE_CALLBACK_PATH, pageLimiter, (req, res, next) => {
    res.setHeader("Content-Security-Policy", HTML_CSP);
    void provider.handleGoogleCallback(req, res, next);
  });

  // ── Publish approval pages (opened by the owner from the link Claude shows) ──
  const approvalHeaders = (_req: Request, res: Response, next: NextFunction): void => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Security-Policy", HTML_CSP);
    res.setHeader("X-Robots-Tag", "noindex");
    next();
  };

  const expired = (res: Response): void => {
    res.status(404).type("html").send(errorPage(lang, s.expired));
  };

  app.get("/approve/:id", pageLimiter, approvalHeaders, (req, res) => {
    const id = String(req.params["id"]);
    const approval = approvals.get(id);
    if (!approval || approval.status !== "pending") return expired(res);
    const a = approval.action;
    const view: ApprovalView = {
      kind: a.kind,
      videoId: a.videoId,
      videoTitle: approval.snapshot.videoTitle,
      thumbnailUrl: approval.snapshot.thumbnailUrl,
      currentPrivacy: approval.snapshot.currentPrivacy,
      privacyStatus: a.kind === "set_privacy" ? a.privacyStatus : undefined,
      publishAtUtc: a.kind === "schedule" ? new Date(a.publishAt).toISOString() : undefined,
      publishAtLocal: a.kind === "schedule" ? formatLocal(a.publishAt, cfg.displayTimeZone, lang) : undefined,
      timeZone: cfg.displayTimeZone,
    };
    const csrf = crypto.seal("csrf", { id }, 30 * 60);
    res.type("html").send(approvalPage(lang, id, csrf, view));
  });

  app.post(
    "/approve/:id",
    pageLimiter,
    approvalHeaders,
    express.urlencoded({ extended: false, limit: "4kb" }),
    (req, res) => {
      const id = String(req.params["id"]);
      const site = req.headers["sec-fetch-site"];
      if (typeof site === "string" && site !== "same-origin" && site !== "none") {
        res.status(403).type("html").send(errorPage(lang, s.errorTitle));
        return;
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const token = crypto.open<{ id: string }>("csrf", String(body["csrf"] ?? ""));
      if (!token || token.id !== id) return expired(res);
      const decision = body["decision"] === "approve" ? "approve" : body["decision"] === "reject" ? "reject" : undefined;
      if (!decision) return expired(res);
      const result = approvals.decide(id, decision);
      if (!result) return expired(res);
      logger.info(`Publish approval ${decision === "approve" ? "granted" : "declined"} by the owner`);
      res.type("html").send(approvalResultPage(lang, decision === "approve"));
    }
  );

  // ── MCP endpoint: stateless Streamable HTTP ────────────────────────────────
  const allowedOrigins = new Set([...DEFAULT_ALLOWED_ORIGINS, ...cfg.allowedOrigins]);
  const originGuard = (req: Request, res: Response, next: NextFunction): void => {
    const origin = req.headers.origin;
    if (origin && !allowedOrigins.has(origin)) {
      jsonRpcError(res, 403, -32000, "Origin not allowed");
      return;
    }
    next();
  };

  const bearer = requireBearerAuth({
    verifier: provider,
    requiredScopes: [OUR_SCOPE],
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(provider.resourceUrl),
    expectedResource: provider.resourceUrl,
  });

  app.post("/mcp", originGuard, bearer, express.json({ limit: "512kb" }), async (req, res) => {
    const principal = principalFromAuth(req.auth!);
    const server = opts.createMcpServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
      enableJsonResponse: true,
    });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await runWithPrincipal(principal, () => transport.handleRequest(req, res, req.body));
    } catch (err) {
      logger.error("MCP request failed", { reason: err instanceof Error ? err.name : "unknown" });
      if (!res.headersSent) jsonRpcError(res, 500, -32603, "Internal server error");
    }
  });

  // Stateless server: no server-initiated SSE stream and no sessions to terminate.
  app.all("/mcp", originGuard, (_req, res) => {
    res.setHeader("Allow", "POST");
    jsonRpcError(res, 405, -32000, "Method not allowed. Use POST.");
  });

  app.use((_req, res) => {
    res.status(404).json({ error: "not_found" });
  });

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    const status = (err as { status?: number; statusCode?: number })?.status ?? (err as { statusCode?: number })?.statusCode ?? 500;
    if (status >= 500) logger.error("Unhandled request error", { reason: err instanceof Error ? err.name : "unknown" });
    if (res.headersSent) return;
    if (req.path === "/mcp") {
      jsonRpcError(res, status >= 400 && status < 600 ? status : 500, status === 400 ? -32700 : -32603, status === 400 ? "Parse error" : "Internal server error");
      return;
    }
    res.status(status >= 400 && status < 600 ? status : 500).json({ error: "request_failed" });
  });

  return app;
}
