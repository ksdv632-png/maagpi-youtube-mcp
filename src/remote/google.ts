import { createHash, randomBytes } from "node:crypto";

/**
 * Minimal Google OAuth 2.0 (web-server flow + PKCE) client used by the remote server.
 * `fetchImpl` is injectable so the flow can be tested without network access.
 */

export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
export const GOOGLE_USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";

const YT = "https://www.googleapis.com/auth";

/** Least-privilege scope set. (`youtubepartner` from the old local flow is intentionally NOT requested.) */
export const GOOGLE_SCOPES = [
  "openid",
  "email",
  `${YT}/youtube`,
  `${YT}/youtube.force-ssl`,
  `${YT}/youtube.upload`,
  `${YT}/yt-analytics.readonly`,
  `${YT}/yt-analytics-monetary.readonly`,
];

/** Scopes without which the server cannot do its job; the consent screen allows un-ticking boxes. */
export const REQUIRED_GOOGLE_SCOPES = [`${YT}/youtube`, `${YT}/youtube.force-ssl`];

export class GoogleInvalidGrantError extends Error {
  constructor(message = "Google rejected the refresh token (invalid_grant)") {
    super(message);
    this.name = "GoogleInvalidGrantError";
  }
}

export class GoogleTransientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoogleTransientError";
  }
}

export interface GoogleTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope: string;
  token_type: string;
  id_token?: string;
}

export interface GoogleUserInfo {
  sub: string;
  email?: string;
  email_verified?: boolean;
}

export interface GoogleOAuth {
  generatePkce(): { verifier: string; challenge: string };
  buildAuthUrl(args: { redirectUri: string; state: string; codeChallenge: string; loginHint?: string }): string;
  exchangeCode(args: { code: string; redirectUri: string; codeVerifier: string }): Promise<GoogleTokenResponse>;
  refreshAccessToken(refreshToken: string): Promise<{ access_token: string; expires_in: number }>;
  userInfo(accessToken: string): Promise<GoogleUserInfo>;
  ownChannel(accessToken: string): Promise<{ id: string; title?: string } | null>;
  revoke(token: string): Promise<void>;
}

export function createGoogleOAuth(opts: {
  clientId: string;
  clientSecret: string;
  fetchImpl?: typeof fetch;
}): GoogleOAuth {
  const doFetch: typeof fetch = opts.fetchImpl ?? ((...a) => fetch(...a));

  async function postForm(url: string, form: Record<string, string>): Promise<Response> {
    try {
      return await doFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: new URLSearchParams(form).toString(),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      throw new GoogleTransientError(`Could not reach Google: ${err instanceof Error ? err.message : "network error"}`);
    }
  }

  async function readError(res: Response): Promise<{ error?: string; error_description?: string }> {
    try {
      return (await res.json()) as { error?: string; error_description?: string };
    } catch {
      return {};
    }
  }

  return {
    generatePkce() {
      const verifier = randomBytes(48).toString("base64url");
      const challenge = createHash("sha256").update(verifier).digest("base64url");
      return { verifier, challenge };
    },

    buildAuthUrl({ redirectUri, state, codeChallenge, loginHint }) {
      const url = new URL(GOOGLE_AUTH_URL);
      url.searchParams.set("client_id", opts.clientId);
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("scope", GOOGLE_SCOPES.join(" "));
      url.searchParams.set("access_type", "offline");
      // consent → always return a refresh token; select_account → let the owner pick the
      // Google account (and brand channel) that holds the YouTube channel.
      url.searchParams.set("prompt", "select_account consent");
      url.searchParams.set("include_granted_scopes", "false");
      url.searchParams.set("state", state);
      url.searchParams.set("code_challenge", codeChallenge);
      url.searchParams.set("code_challenge_method", "S256");
      if (loginHint) url.searchParams.set("login_hint", loginHint);
      return url.toString();
    },

    async exchangeCode({ code, redirectUri, codeVerifier }) {
      const res = await postForm(GOOGLE_TOKEN_URL, {
        code,
        client_id: opts.clientId,
        client_secret: opts.clientSecret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
        code_verifier: codeVerifier,
      });
      if (!res.ok) {
        const err = await readError(res);
        if (res.status >= 500) throw new GoogleTransientError(`Google token endpoint error ${res.status}`);
        throw new GoogleInvalidGrantError(`Google refused the sign-in code (${err.error ?? res.status})`);
      }
      return (await res.json()) as GoogleTokenResponse;
    },

    async refreshAccessToken(refreshToken) {
      const res = await postForm(GOOGLE_TOKEN_URL, {
        refresh_token: refreshToken,
        client_id: opts.clientId,
        client_secret: opts.clientSecret,
        grant_type: "refresh_token",
      });
      if (!res.ok) {
        const err = await readError(res);
        if (res.status >= 500 || res.status === 429) {
          throw new GoogleTransientError(`Google token endpoint error ${res.status}`);
        }
        if (err.error === "invalid_grant") throw new GoogleInvalidGrantError();
        throw new GoogleInvalidGrantError(`Google refused the refresh token (${err.error ?? res.status})`);
      }
      const body = (await res.json()) as { access_token: string; expires_in: number };
      return { access_token: body.access_token, expires_in: body.expires_in };
    },

    async userInfo(accessToken) {
      let res: Response;
      try {
        res = await doFetch(GOOGLE_USERINFO_URL, {
          headers: { Authorization: `Bearer ${accessToken}` },
          signal: AbortSignal.timeout(15_000),
        });
      } catch (err) {
        throw new GoogleTransientError(`Could not reach Google: ${err instanceof Error ? err.message : "network error"}`);
      }
      if (!res.ok) throw new GoogleTransientError(`Google userinfo error ${res.status}`);
      return (await res.json()) as GoogleUserInfo;
    },

    async ownChannel(accessToken) {
      try {
        const res = await doFetch("https://www.googleapis.com/youtube/v3/channels?part=id,snippet&mine=true", {
          headers: { Authorization: `Bearer ${accessToken}` },
          signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) return null;
        const body = (await res.json()) as { items?: Array<{ id: string; snippet?: { title?: string } }> };
        const item = body.items?.[0];
        return item ? { id: item.id, title: item.snippet?.title } : null;
      } catch {
        return null;
      }
    },

    async revoke(token) {
      try {
        await postForm(GOOGLE_REVOKE_URL, { token });
      } catch {
        /* best effort */
      }
    },
  };
}
