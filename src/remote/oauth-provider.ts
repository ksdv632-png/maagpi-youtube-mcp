import type { Request, RequestHandler, Response } from "express";
import type {
  AuthorizationParams,
  OAuthServerProvider,
} from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { OAuthClientInformationFull, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import {
  InvalidGrantError,
  InvalidTargetError,
  InvalidTokenError,
  ServerError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { RemotePrincipal } from "../auth/context.js";
import { logger } from "../logger.js";
import { randomToken, safeEqual, type TokenCrypto } from "./crypto.js";
import { StatelessClientsStore } from "./clients-store.js";
import {
  GoogleInvalidGrantError,
  GoogleTransientError,
  REQUIRED_GOOGLE_SCOPES,
  type GoogleOAuth,
} from "./google.js";
import { errorPage, strings, type Lang } from "./pages.js";

/**
 * OAuth 2.1 authorization server that Claude talks to (DCR + PKCE), which delegates the
 * actual sign-in to Google. Fully stateless: see crypto.ts.
 *
 *   Claude ──/authorize──▶ this server ──redirect──▶ Google (owner signs in, picks channel)
 *   Claude ◀─ code ─────── this server ◀─/oauth/google/callback── Google
 *   Claude ──/token──────▶ this server  (returns sealed access + refresh tokens that carry
 *                                        the Google refresh token, encrypted)
 */

export const OUR_SCOPE = "youtube";
export const GOOGLE_CALLBACK_PATH = "/oauth/google/callback";
const COOKIE_NAME = "mcp_oauth_nonce";
const ACCESS_TTL_SECONDS = 3600;
const REFRESH_TTL_SECONDS = 90 * 24 * 3600;
const STATE_TTL_SECONDS = 600;
const CODE_TTL_SECONDS = 120;

interface GState {
  cid: string;
  ru: string;
  cc: string;
  st?: string;
  res?: string;
  nonce: string;
  gv: string;
}
interface CodePayload {
  cid: string;
  ru: string;
  cc: string;
  res?: string;
  sub: string;
  email: string;
  rt: string;
  gs: string;
  jti: string;
}
interface TokenPayload {
  cid: string;
  sub: string;
  email: string;
  rt: string;
  gs: string;
  aud: string;
}

export interface ProviderOptions {
  crypto: TokenCrypto;
  google: GoogleOAuth;
  publicUrl: string;
  allowedEmails: string[];
  allowedChannelId?: string;
  extraRedirectUris?: string[];
  lang: Lang;
}

function withoutTrailingSlash(u: string): string {
  return u.replace(/#.*$/, "").replace(/\/$/, "");
}

function getCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx > 0 && part.slice(0, idx).trim() === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return undefined;
}

function redirectWith(base: string, params: Record<string, string | undefined>): string {
  const url = new URL(base);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, v);
  return url.toString();
}

export function principalFromAuth(auth: AuthInfo): RemotePrincipal {
  const extra = auth.extra ?? {};
  return {
    sub: String(extra["sub"]),
    email: String(extra["email"]),
    googleRefreshToken: String(extra["rt"]),
    googleScope: String(extra["gs"] ?? ""),
    clientId: auth.clientId,
  };
}

export class GoogleBackedOAuthProvider implements OAuthServerProvider {
  readonly clientsStore: OAuthRegisteredClientsStore;
  readonly resourceUrl: URL;
  private readonly googleRedirectUri: string;
  private readonly secureCookie: boolean;
  /** Authorization-code ids already redeemed (single use). Entries expire with the code. */
  private readonly usedCodes = new Map<string, number>();

  constructor(private readonly opts: ProviderOptions) {
    this.clientsStore = new StatelessClientsStore(opts.crypto, opts.extraRedirectUris ?? []);
    this.resourceUrl = new URL(`${opts.publicUrl}/mcp`);
    this.googleRedirectUri = `${opts.publicUrl}${GOOGLE_CALLBACK_PATH}`;
    this.secureCookie = opts.publicUrl.startsWith("https:");
  }

  // ── Step 1: Claude sends the user here ─────────────────────────────────────
  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    if (params.resource && withoutTrailingSlash(params.resource.href) !== withoutTrailingSlash(this.resourceUrl.href)) {
      throw new InvalidTargetError("The requested resource is not served by this authorization server");
    }
    const nonce = randomToken(16);
    const pkce = this.opts.google.generatePkce();
    const state = this.opts.crypto.seal<GState>(
      "gstate",
      {
        cid: client.client_id,
        ru: params.redirectUri,
        cc: params.codeChallenge,
        st: params.state,
        res: params.resource?.href,
        nonce,
        gv: pkce.verifier,
      },
      STATE_TTL_SECONDS
    );
    // The cookie ties the Google callback to the browser that started the flow (login-CSRF protection).
    res.cookie(COOKIE_NAME, nonce, {
      httpOnly: true,
      secure: this.secureCookie,
      sameSite: "lax",
      path: GOOGLE_CALLBACK_PATH,
      maxAge: STATE_TTL_SECONDS * 1000,
    });
    const loginHint = this.opts.allowedEmails.length === 1 ? this.opts.allowedEmails[0] : undefined;
    res.redirect(
      302,
      this.opts.google.buildAuthUrl({
        redirectUri: this.googleRedirectUri,
        state,
        codeChallenge: pkce.challenge,
        loginHint,
      })
    );
  }

  // ── Step 2: Google sends the user back here ────────────────────────────────
  readonly handleGoogleCallback: RequestHandler = async (req, res) => {
    const s = strings(this.opts.lang);
    res.setHeader("Cache-Control", "no-store");
    const fail = (status: number, message: string): void => {
      res.status(status).type("html").send(errorPage(this.opts.lang, message));
    };

    const stateParam = typeof req.query["state"] === "string" ? req.query["state"] : "";
    const st = this.opts.crypto.open<GState>("gstate", stateParam);
    const cookieNonce = getCookie(req, COOKIE_NAME);
    res.clearCookie(COOKIE_NAME, { path: GOOGLE_CALLBACK_PATH, secure: this.secureCookie, httpOnly: true, sameSite: "lax" });
    if (!st || !cookieNonce || !safeEqual(cookieNonce, st.nonce)) {
      return fail(400, s.sessionExpired);
    }

    if (typeof req.query["error"] === "string") {
      res.redirect(
        302,
        redirectWith(st.ru, {
          error: "access_denied",
          error_description: "Google sign-in was cancelled or denied",
          state: st.st,
        })
      );
      return;
    }
    const code = typeof req.query["code"] === "string" ? req.query["code"] : "";
    if (!code) return fail(400, s.googleError);

    try {
      const tokens = await this.opts.google.exchangeCode({
        code,
        redirectUri: this.googleRedirectUri,
        codeVerifier: st.gv,
      });
      const revokeAll = (): void => void this.opts.google.revoke(tokens.refresh_token ?? tokens.access_token);

      if (!tokens.refresh_token) {
        revokeAll();
        return fail(400, s.noRefresh);
      }
      const granted = (tokens.scope ?? "").split(" ");
      if (!REQUIRED_GOOGLE_SCOPES.every((sc) => granted.includes(sc))) {
        revokeAll();
        return fail(400, s.missingScopes);
      }

      const info = await this.opts.google.userInfo(tokens.access_token);
      const email = info.email?.toLowerCase();
      if (!info.sub || !email || info.email_verified === false || !this.opts.allowedEmails.includes(email)) {
        revokeAll();
        logger.warn("Rejected sign-in from an account that is not on the allow-list");
        return fail(403, s.forbiddenAccount);
      }

      if (this.opts.allowedChannelId) {
        const channel = await this.opts.google.ownChannel(tokens.access_token);
        if (!channel) {
          revokeAll();
          return fail(400, s.noChannel);
        }
        if (channel.id !== this.opts.allowedChannelId) {
          revokeAll();
          return fail(403, s.wrongChannel);
        }
      }

      const authCode = this.opts.crypto.seal<CodePayload>(
        "code",
        {
          cid: st.cid,
          ru: st.ru,
          cc: st.cc,
          res: st.res,
          sub: info.sub,
          email,
          rt: tokens.refresh_token,
          gs: tokens.scope,
          jti: randomToken(16),
        },
        CODE_TTL_SECONDS
      );
      res.redirect(302, redirectWith(st.ru, { code: authCode, state: st.st }));
    } catch (err) {
      logger.warn("Google sign-in callback failed", { reason: err instanceof Error ? err.name : "unknown" });
      if (err instanceof GoogleTransientError) return fail(502, s.googleError);
      return fail(400, s.googleError + " " + s.tryAgain);
    }
  };

  // ── Step 3: Claude redeems the code ────────────────────────────────────────
  async challengeForAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
    const p = this.opts.crypto.open<CodePayload>("code", authorizationCode);
    if (!p || p.cid !== client.client_id) throw new InvalidGrantError("Invalid or expired authorization code");
    return p.cc;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL
  ): Promise<OAuthTokens> {
    const p = this.opts.crypto.open<CodePayload>("code", authorizationCode);
    if (!p || p.cid !== client.client_id) throw new InvalidGrantError("Invalid or expired authorization code");
    if (redirectUri !== undefined && redirectUri !== p.ru) throw new InvalidGrantError("redirect_uri does not match");
    if (resource && withoutTrailingSlash(resource.href) !== withoutTrailingSlash(this.resourceUrl.href)) {
      throw new InvalidTargetError("The requested resource is not served by this authorization server");
    }
    if (!this.markCodeUsed(p.jti, p.exp)) throw new InvalidGrantError("Authorization code was already used");
    this.assertAllowed(p.email, () => new InvalidGrantError("This account is not allowed"));
    return this.issueTokens({ cid: p.cid, sub: p.sub, email: p.email, rt: p.rt, gs: p.gs });
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string): Promise<OAuthTokens> {
    const p = this.opts.crypto.open<TokenPayload>("rt", refreshToken);
    if (!p || p.cid !== client.client_id || p.aud !== this.resourceUrl.href) {
      throw new InvalidGrantError("Invalid or expired refresh token");
    }
    this.assertAllowed(p.email, () => new InvalidGrantError("This account is not allowed"));
    try {
      // Make sure the owner has not revoked access (or that Google's 7-day "Testing" expiry did not hit).
      await this.opts.google.refreshAccessToken(p.rt);
    } catch (err) {
      if (err instanceof GoogleInvalidGrantError) {
        throw new InvalidGrantError("Google access was revoked or expired. Reconnect the connector.");
      }
      if (err instanceof GoogleTransientError) throw new ServerError("Google is temporarily unavailable");
      throw err;
    }
    return this.issueTokens({ cid: p.cid, sub: p.sub, email: p.email, rt: p.rt, gs: p.gs });
  }

  // ── Every MCP request ──────────────────────────────────────────────────────
  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const p = this.opts.crypto.open<TokenPayload>("at", token);
    if (!p || p.aud !== this.resourceUrl.href) throw new InvalidTokenError("Invalid or expired access token");
    this.assertAllowed(p.email, () => new InvalidTokenError("This account is not allowed"));
    return {
      token: "",
      clientId: p.cid,
      scopes: [OUR_SCOPE],
      expiresAt: p.exp,
      resource: this.resourceUrl,
      extra: { sub: p.sub, email: p.email, rt: p.rt, gs: p.gs },
    };
  }

  // ── helpers ────────────────────────────────────────────────────────────────
  private assertAllowed(email: string, makeError: () => Error): void {
    if (!this.opts.allowedEmails.includes(email.toLowerCase())) throw makeError();
  }

  private issueTokens(p: Omit<TokenPayload, "aud">): OAuthTokens {
    const payload: TokenPayload = { ...p, aud: this.resourceUrl.href };
    return {
      access_token: this.opts.crypto.seal("at", payload, ACCESS_TTL_SECONDS),
      token_type: "Bearer",
      expires_in: ACCESS_TTL_SECONDS,
      refresh_token: this.opts.crypto.seal("rt", payload, REFRESH_TTL_SECONDS),
      scope: OUR_SCOPE,
    };
  }

  private markCodeUsed(jti: string, expSeconds: number): boolean {
    const now = Date.now();
    for (const [id, exp] of this.usedCodes) if (exp * 1000 <= now) this.usedCodes.delete(id);
    if (this.usedCodes.has(jti)) return false;
    this.usedCodes.set(jti, expSeconds);
    return true;
  }
}
