/**
 * End-to-end test of the REMOTE server: Claude-style OAuth (DCR + PKCE) → Google sign-in (faked)
 * → Streamable-HTTP MCP session → tools, with a fake YouTube API behind them.
 *
 * It proves the safety promises: no video deletion, uploads are private, publishing only after
 * the owner pressed "Approve", allow-listed Google account only, per-user isolation.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import net from "node:net";
import { createHash, randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import type { Server } from "node:http";

// ── Environment must be in place before the app modules are imported ───────────
const freePort = await new Promise<number>((resolve) => {
  const s = net.createServer().listen(0, "127.0.0.1", () => {
    const { port } = s.address() as net.AddressInfo;
    s.close(() => resolve(port));
  });
});
const BASE = `http://127.0.0.1:${freePort}`;
process.env["YOUTUBE_MCP_TRANSPORT"] = "http";
process.env["PUBLIC_URL"] = BASE;
process.env["TOKEN_ENCRYPTION_KEY"] = "integration-test-key-0123456789abcdef-0123456789";
process.env["ALLOWED_GOOGLE_EMAILS"] = "Owner@Example.com, second@example.com";
process.env["DISPLAY_TIMEZONE"] = "Europe/Kyiv";

const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from("ftypisom"), Buffer.alloc(2048, 7)]);

// ── Fakes ──────────────────────────────────────────────────────────────────────
const fake = vi.hoisted(() => {
  const state = {
    title: "My clip",
    status: {
      privacyStatus: "private",
      embeddable: false,
      license: "creativeCommon",
      publicStatsViewable: true,
      selfDeclaredMadeForKids: false,
      uploadStatus: "processed",
    } as Record<string, unknown>,
    updates: [] as Array<Record<string, any>>,
    inserts: [] as Array<{ request: Record<string, any>; bytes: number }>,
    thumbnails: [] as unknown[],
  };
  const yt = {
    videos: {
      list: async (req: { id: string[] }) => ({
        data: {
          items: [
            {
              id: req.id[0],
              snippet: { title: state.title, categoryId: "22", thumbnails: { medium: { url: "https://i.ytimg.com/vi/x/mq.jpg" } } },
              status: { ...state.status },
            },
          ],
        },
      }),
      update: async (req: Record<string, any>) => {
        state.updates.push(req);
        return { data: { id: req.requestBody.id, status: { ...req.requestBody.status, uploadStatus: "processed" } } };
      },
      insert: async (req: Record<string, any>) => {
        const chunks: Buffer[] = [];
        for await (const c of req.media.body as AsyncIterable<Buffer>) chunks.push(c);
        state.inserts.push({ request: req, bytes: Buffer.concat(chunks).length });
        return {
          data: {
            id: "newVid123",
            snippet: { title: req.requestBody.snippet.title },
            status: { privacyStatus: req.requestBody.status.privacyStatus, uploadStatus: "uploaded" },
          },
        };
      },
    },
    channels: {
      list: async () => ({
        data: {
          items: [
            {
              id: "UCchannel1",
              snippet: { title: "Test channel", customUrl: "@test" },
              statistics: { subscriberCount: "42", videoCount: "7" },
              contentDetails: { relatedPlaylists: { uploads: "UUuploads" } },
            },
          ],
        },
      }),
    },
    thumbnails: { set: async (req: unknown) => { state.thumbnails.push(req); return { data: {} }; } },
  };
  return { state, yt };
});

vi.mock("../../src/youtube/client.js", () => ({
  buildYouTubeClient: () => fake.yt,
  buildAnalyticsClient: () => ({}),
}));

vi.mock("../../src/net/safe-download.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/net/safe-download.js")>();
  return {
    ...original,
    openDownload: vi.fn(async () => ({
      stream: Readable.from([MP4]),
      contentLength: MP4.length,
      mimeType: "video/mp4",
      finalHost: "files.example.com",
    })),
  };
});

const google = {
  email: "owner@example.com",
  scope: [
    "openid", "email",
    "https://www.googleapis.com/auth/youtube",
    "https://www.googleapis.com/auth/youtube.force-ssl",
    "https://www.googleapis.com/auth/youtube.upload",
    "https://www.googleapis.com/auth/yt-analytics.readonly",
  ].join(" "),
  refreshFails: false,
  revoked: [] as string[],
  tokenRequests: 0,
};
const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const fakeFetch = (async (input: unknown, init?: RequestInit) => {
  const url = String(input);
  if (url === "https://oauth2.googleapis.com/token") {
    google.tokenRequests++;
    const form = new URLSearchParams(String(init?.body));
    if (form.get("grant_type") === "authorization_code") {
      return json({
        access_token: "ya29.fake-access",
        refresh_token: `1//refresh-for-${google.email}-0123456789abcdef`,
        expires_in: 3599,
        scope: google.scope,
        token_type: "Bearer",
      });
    }
    return google.refreshFails ? json({ error: "invalid_grant" }, 400) : json({ access_token: "ya29.renewed", expires_in: 3599 });
  }
  if (url === "https://openidconnect.googleapis.com/v1/userinfo") {
    return json({ sub: `sub-${google.email}`, email: google.email, email_verified: true });
  }
  if (url === "https://oauth2.googleapis.com/revoke") {
    google.revoked.push(String(new URLSearchParams(String(init?.body)).get("token")));
    return json({});
  }
  throw new Error(`unexpected outbound fetch: ${url}`);
}) as typeof fetch;

// ── Modules under test (imported after env + mocks) ────────────────────────────
const { config } = await import("../../src/config.js");
const { createRemoteApp } = await import("../../src/remote/app.js");
const { createGoogleOAuth } = await import("../../src/remote/google.js");
const { createServer } = await import("../../src/server.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");

const CLAUDE_CALLBACK = "https://claude.ai/api/mcp/auth_callback";
let httpServer: Server;

beforeAll(async () => {
  const app = createRemoteApp({
    config,
    createMcpServer: createServer,
    google: createGoogleOAuth({ clientId: "cid", clientSecret: "csecret", fetchImpl: fakeFetch }),
  });
  await new Promise<void>((resolve) => {
    httpServer = app.listen(freePort, "127.0.0.1", () => resolve());
  });
});
afterAll(async () => {
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

// ── helpers ────────────────────────────────────────────────────────────────────
const pkce = () => {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
};

async function registerClient(redirectUri = CLAUDE_CALLBACK): Promise<Response> {
  return fetch(`${BASE}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "Claude",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
}

async function beginAuthorize(clientId: string, challenge: string, extra: Record<string, string> = {}) {
  const url = new URL(`${BASE}/authorize`);
  const params: Record<string, string> = {
    response_type: "code",
    client_id: clientId,
    redirect_uri: CLAUDE_CALLBACK,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "claude-state-1",
    scope: "youtube",
    resource: `${BASE}/mcp`,
    ...extra,
  };
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return fetch(url, { redirect: "manual" });
}

// The server rate-limits client registration (20/hour), so tests share one registered client.
let sharedClientId: string | undefined;
async function getSharedClientId(): Promise<string> {
  if (!sharedClientId) {
    sharedClientId = ((await (await registerClient()).json()) as { client_id: string }).client_id;
  }
  return sharedClientId;
}

async function signIn(email: string): Promise<{ accessToken: string; refreshToken: string; clientId: string }> {
  google.email = email;
  const clientId = await getSharedClientId();
  const { verifier, challenge } = pkce();
  const auth = await beginAuthorize(clientId, challenge);
  const googleUrl = new URL(auth.headers.get("location")!);
  const cookie = auth.headers.get("set-cookie")!.split(";")[0]!;
  const cb = await fetch(
    `${BASE}/oauth/google/callback?code=google-code&state=${encodeURIComponent(googleUrl.searchParams.get("state")!)}`,
    { redirect: "manual", headers: { Cookie: cookie } }
  );
  expect(cb.status).toBe(302);
  const back = new URL(cb.headers.get("location")!);
  expect(back.origin + back.pathname).toBe(CLAUDE_CALLBACK);
  expect(back.searchParams.get("state")).toBe("claude-state-1");
  const code = back.searchParams.get("code")!;
  const tokenRes = await exchangeCode(clientId, code, verifier);
  expect(tokenRes.status).toBe(200);
  const tokens = (await tokenRes.json()) as { access_token: string; refresh_token: string };
  return { accessToken: tokens.access_token, refreshToken: tokens.refresh_token, clientId };
}

function exchangeCode(clientId: string, code: string, verifier: string): Promise<Response> {
  return fetch(`${BASE}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      client_id: clientId,
      redirect_uri: CLAUDE_CALLBACK,
      resource: `${BASE}/mcp`,
    }),
  });
}

async function connect(accessToken: string) {
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${accessToken}` } },
    })
  );
  return client;
}

type McpClient = Awaited<ReturnType<typeof connect>>;
async function call(client: McpClient, name: string, args: Record<string, unknown> = {}) {
  const res = (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content: Array<{ type: string; text: string }>;
  };
  let data: any;
  try {
    data = JSON.parse(res.content[0]!.text);
  } catch {
    data = res.content[0]!.text;
  }
  return { isError: !!res.isError, data };
}

async function approveInBrowser(approvalUrl: string, decision: "approve" | "reject" = "approve") {
  const page = await fetch(approvalUrl);
  const html = await page.text();
  expect(page.status).toBe(200);
  const csrf = /name="csrf" value="([^"]+)"/.exec(html)![1]!;
  const post = await fetch(approvalUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ csrf, decision }),
  });
  return { html, status: post.status };
}

// ── tests ──────────────────────────────────────────────────────────────────────
describe("discovery & HTTP hardening", () => {
  it("publishes OAuth metadata that Claude's connector can discover", async () => {
    const as = (await (await fetch(`${BASE}/.well-known/oauth-authorization-server`)).json()) as Record<string, any>;
    expect(as.issuer).toBe(`${BASE}/`);
    expect(as.authorization_endpoint).toBe(`${BASE}/authorize`);
    expect(as.token_endpoint).toBe(`${BASE}/token`);
    expect(as.registration_endpoint).toBe(`${BASE}/register`);
    expect(as.code_challenge_methods_supported).toEqual(["S256"]);
    expect(as.grant_types_supported).toEqual(expect.arrayContaining(["authorization_code", "refresh_token"]));

    const rs = (await (await fetch(`${BASE}/.well-known/oauth-protected-resource/mcp`)).json()) as Record<string, any>;
    expect(rs.resource).toBe(`${BASE}/mcp`);
    expect(rs.authorization_servers).toEqual([`${BASE}/`]);
  });

  it("answers 401 with a resource_metadata hint when no token is sent", async () => {
    const res = await fetch(`${BASE}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain(`resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp"`);
  });

  it("rejects garbage and wrong-type tokens", async () => {
    const { refreshToken } = await signIn("owner@example.com");
    for (const token of ["garbage", "v1.AAAA", refreshToken /* refresh token used as access token */]) {
      const res = await fetch(`${BASE}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      expect(res.status).toBe(401);
    }
  });

  it("refuses browsers from other origins, GET/DELETE and oversized bodies", async () => {
    const { accessToken } = await signIn("owner@example.com");
    const headers = { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${accessToken}` };
    const evil = await fetch(`${BASE}/mcp`, { method: "POST", headers: { ...headers, Origin: "https://evil.example" }, body: "{}" });
    expect(evil.status).toBe(403);
    expect((await fetch(`${BASE}/mcp`, { method: "GET", headers })).status).toBe(405);
    expect((await fetch(`${BASE}/mcp`, { method: "DELETE", headers })).status).toBe(405);
    const big = await fetch(`${BASE}/mcp`, { method: "POST", headers, body: JSON.stringify({ x: "a".repeat(600_000) }) });
    expect(big.status).toBe(413);
  });

  it("sets security headers and a health endpoint that leaks nothing", async () => {
    const res = await fetch(`${BASE}/health`);
    expect(await res.json()).toEqual({ status: "ok" });
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("x-powered-by")).toBeNull();
  });
});

describe("OAuth: Claude → this server → Google", () => {
  it("registers Claude's callback but refuses foreign redirect URIs", async () => {
    expect((await registerClient(CLAUDE_CALLBACK)).status).toBe(201);
    expect((await registerClient("https://evil.example/callback")).status).toBe(400);
    expect((await registerClient("http://127.0.0.1:6274/oauth/callback")).status).toBe(201);
  });

  it("sends the user to Google with PKCE, offline access and least-privilege scopes", async () => {
    const client_id = await getSharedClientId();
    const res = await beginAuthorize(client_id, pkce().challenge);
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.origin + loc.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(loc.searchParams.get("redirect_uri")).toBe(`${BASE}/oauth/google/callback`);
    expect(loc.searchParams.get("access_type")).toBe("offline");
    expect(loc.searchParams.get("prompt")).toContain("consent");
    expect(loc.searchParams.get("code_challenge_method")).toBe("S256");
    expect(loc.searchParams.get("login_hint")).toBeNull(); // two allowed accounts → no hint
    const scope = loc.searchParams.get("scope")!;
    expect(scope).toContain("https://www.googleapis.com/auth/youtube.force-ssl");
    expect(scope).not.toContain("youtubepartner");
    const cookie = res.headers.get("set-cookie")!;
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
  });

  it("rejects an authorize request for a different resource (RFC 8707)", async () => {
    const client_id = await getSharedClientId();
    const res = await beginAuthorize(client_id, pkce().challenge, { resource: "https://evil.example/mcp" });
    expect(new URL(res.headers.get("location")!).searchParams.get("error")).toBe("invalid_target");
  });

  it("rejects a Google callback without the browser cookie (login CSRF)", async () => {
    const client_id = await getSharedClientId();
    const auth = await beginAuthorize(client_id, pkce().challenge);
    const state = new URL(auth.headers.get("location")!).searchParams.get("state")!;
    const res = await fetch(`${BASE}/oauth/google/callback?code=x&state=${encodeURIComponent(state)}`, { redirect: "manual" });
    expect(res.status).toBe(400);
    const forged = await fetch(`${BASE}/oauth/google/callback?code=x&state=forged`, { redirect: "manual", headers: { Cookie: "mcp_oauth_nonce=abc" } });
    expect(forged.status).toBe(400);
  });

  it("only lets the allow-listed Google account in, and revokes the stranger's grant", async () => {
    google.email = "stranger@example.com";
    google.revoked.length = 0;
    const client_id = await getSharedClientId();
    const auth = await beginAuthorize(client_id, pkce().challenge);
    const state = new URL(auth.headers.get("location")!).searchParams.get("state")!;
    const cookie = auth.headers.get("set-cookie")!.split(";")[0]!;
    const res = await fetch(`${BASE}/oauth/google/callback?code=google-code&state=${encodeURIComponent(state)}`, {
      redirect: "manual",
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(403);
    expect(res.headers.get("location")).toBeNull();
    expect(google.revoked.length).toBe(1);
  });

  it("requires the YouTube scopes (Google lets users untick them)", async () => {
    const original = google.scope;
    google.scope = "openid email";
    google.email = "owner@example.com";
    const client_id = await getSharedClientId();
    const auth = await beginAuthorize(client_id, pkce().challenge);
    const state = new URL(auth.headers.get("location")!).searchParams.get("state")!;
    const cookie = auth.headers.get("set-cookie")!.split(";")[0]!;
    const res = await fetch(`${BASE}/oauth/google/callback?code=c&state=${encodeURIComponent(state)}`, { redirect: "manual", headers: { Cookie: cookie } });
    google.scope = original;
    expect(res.status).toBe(400);
  });

  it("passes a denied Google consent back to Claude as access_denied", async () => {
    const client_id = await getSharedClientId();
    const auth = await beginAuthorize(client_id, pkce().challenge);
    const state = new URL(auth.headers.get("location")!).searchParams.get("state")!;
    const cookie = auth.headers.get("set-cookie")!.split(";")[0]!;
    const res = await fetch(`${BASE}/oauth/google/callback?error=access_denied&state=${encodeURIComponent(state)}`, { redirect: "manual", headers: { Cookie: cookie } });
    const back = new URL(res.headers.get("location")!);
    expect(back.searchParams.get("error")).toBe("access_denied");
    expect(back.searchParams.get("state")).toBe("claude-state-1");
  });

  it("issues tokens only for a correct PKCE verifier, and each code works once", async () => {
    google.email = "owner@example.com";
    const client_id = await getSharedClientId();
    const { verifier, challenge } = pkce();
    const auth = await beginAuthorize(client_id, challenge);
    const state = new URL(auth.headers.get("location")!).searchParams.get("state")!;
    const cookie = auth.headers.get("set-cookie")!.split(";")[0]!;
    const cb = await fetch(`${BASE}/oauth/google/callback?code=g&state=${encodeURIComponent(state)}`, { redirect: "manual", headers: { Cookie: cookie } });
    const code = new URL(cb.headers.get("location")!).searchParams.get("code")!;

    expect((await exchangeCode(client_id, code, pkce().verifier)).status).toBe(400); // wrong verifier
    const ok = await exchangeCode(client_id, code, verifier);
    expect(ok.status).toBe(200);
    const tokens = (await ok.json()) as Record<string, any>;
    expect(tokens.token_type).toBe("Bearer");
    expect(tokens.expires_in).toBe(3600);
    expect(tokens.refresh_token).toBeTruthy();
    expect(JSON.stringify(tokens)).not.toContain("refresh-for-owner"); // Google's refresh token is never visible
    const replay = await exchangeCode(client_id, code, verifier);
    expect(replay.status).toBe(400);
    expect(((await replay.json()) as { error: string }).error).toBe("invalid_grant");
  });

  it("refreshes tokens, and tells Claude to reconnect when Google revoked access", async () => {
    const { refreshToken, clientId } = await signIn("owner@example.com");
    const refresh = () =>
      fetch(`${BASE}/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId }),
      });
    const ok = await refresh();
    expect(ok.status).toBe(200);
    const fresh = (await ok.json()) as { access_token: string };
    await (await connect(fresh.access_token)).close();

    google.refreshFails = true;
    const revoked = await refresh();
    google.refreshFails = false;
    expect(revoked.status).toBe(400);
    expect(((await revoked.json()) as { error: string }).error).toBe("invalid_grant");
  });
});

describe("MCP tools over Streamable HTTP", () => {
  it("exposes the right tool set: no video deletion, no premiere, no local-file inputs", async () => {
    const { accessToken } = await signIn("owner@example.com");
    const client = await connect(accessToken);
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);

    expect(names).not.toContain("youtube_video_delete");
    expect(names).not.toContain("youtube_video_set_premiere");
    // destructive extras are opt-in and off by default
    for (const n of ["youtube_playlist_delete", "youtube_comment_delete", "youtube_channel_section_delete"]) {
      expect(names).not.toContain(n);
    }
    // local multi-profile management does not exist remotely
    for (const n of ["youtube_account_add", "youtube_account_switch", "youtube_account_remove"]) {
      expect(names).not.toContain(n);
    }
    expect(names).toEqual(
      expect.arrayContaining([
        "youtube_video_upload", "youtube_upload_status", "youtube_video_update", "youtube_video_set_thumbnail",
        "youtube_video_set_privacy", "youtube_video_schedule_publish", "youtube_playlist_create",
        "youtube_playlist_item_add", "youtube_channel_update", "youtube_channel_banner_set",
        "youtube_comment_list", "youtube_comment_reply", "youtube_analytics_channel_metrics", "youtube_account_current",
      ])
    );

    for (const tool of tools) {
      expect(tool.annotations, `${tool.name} needs annotations`).toBeDefined();
      expect(typeof tool.annotations?.readOnlyHint).toBe("boolean");
      const props = Object.keys((tool.inputSchema as { properties?: object }).properties ?? {});
      for (const forbidden of ["filePath", "thumbnailPath", "imagePath", "channel", "confirmPublish"]) {
        expect(props, `${tool.name} must not accept ${forbidden} remotely`).not.toContain(forbidden);
      }
    }
    expect(tools.find((t) => t.name === "youtube_video_list")?.annotations?.readOnlyHint).toBe(true);
    expect(tools.find((t) => t.name === "youtube_video_upload")?.annotations?.readOnlyHint).toBe(false);

    const instructions = client.getInstructions() ?? "";
    expect(instructions).toMatch(/Never publish on your own/);
    expect(instructions).toMatch(/cannot delete videos/);
    await client.close();
  });

  it("keeps users apart even when requests run concurrently", async () => {
    const a = await signIn("owner@example.com");
    const b = await signIn("second@example.com");
    const [ca, cb] = [await connect(a.accessToken), await connect(b.accessToken)];
    for (let i = 0; i < 5; i++) {
      const [ra, rb] = await Promise.all([call(ca, "youtube_account_current"), call(cb, "youtube_account_current")]);
      expect(ra.data.data.googleAccount).toBe("owner@example.com");
      expect(rb.data.data.googleAccount).toBe("second@example.com");
    }
    await ca.close();
    await cb.close();
  });

  describe("publishing needs the owner's approval", () => {
    it("never publishes on the first call; publishes after the owner approved; each approval works once", async () => {
      const { accessToken } = await signIn("owner@example.com");
      const client = await connect(accessToken);
      fake.state.updates.length = 0;

      const first = await call(client, "youtube_video_set_privacy", { videoId: "vid1", privacyStatus: "public" });
      expect(first.isError).toBe(false);
      expect(first.data.status).toBe("approval_required");
      expect(first.data.approvalUrl).toMatch(new RegExp(`^${BASE}/approve/`));
      expect(first.data.instructionsForAssistant).toMatch(/STOP/);
      expect(fake.state.updates).toHaveLength(0);

      // the assistant "tries to be clever": calls again with the id before the owner did anything
      const early = await call(client, "youtube_video_set_privacy", { videoId: "vid1", privacyStatus: "public", approvalId: first.data.approvalId });
      expect(early.isError).toBe(true);
      expect(early.data.status).toBe("awaiting_user_approval");
      expect(fake.state.updates).toHaveLength(0);

      // the owner opens the link on the phone and taps "Approve"
      const view = await approveInBrowser(first.data.approvalUrl);
      expect(view.html).toContain("My clip");
      expect(view.html).toMatch(/ПУБЛІЧНИМ/);
      expect(view.status).toBe(200);

      const done = await call(client, "youtube_video_set_privacy", { videoId: "vid1", privacyStatus: "public", approvalId: first.data.approvalId });
      expect(done.isError).toBe(false);
      expect(fake.state.updates).toHaveLength(1);
      const sent = fake.state.updates[0]!.requestBody;
      expect(sent.id).toBe("vid1");
      expect(sent.status.privacyStatus).toBe("public");
      // fields YouTube would otherwise reset are carried over
      expect(sent.status.embeddable).toBe(false);
      expect(sent.status.license).toBe("creativeCommon");
      expect(sent.status.publicStatsViewable).toBe(true);

      const again = await call(client, "youtube_video_set_privacy", { videoId: "vid1", privacyStatus: "public", approvalId: first.data.approvalId });
      expect(again.isError).toBe(true);
      expect(fake.state.updates).toHaveLength(1);
      await client.close();
    });

    it("an approval is valid only for the exact action and only for the same user", async () => {
      const a = await connect((await signIn("owner@example.com")).accessToken);
      const b = await connect((await signIn("second@example.com")).accessToken);
      fake.state.updates.length = 0;

      const req = await call(a, "youtube_video_set_privacy", { videoId: "vid1", privacyStatus: "public" });
      await approveInBrowser(req.data.approvalUrl);

      const otherVideo = await call(a, "youtube_video_set_privacy", { videoId: "vid-OTHER", privacyStatus: "public", approvalId: req.data.approvalId });
      expect(otherVideo.data.status).toBe("approval_mismatch");
      const otherPrivacy = await call(a, "youtube_video_set_privacy", { videoId: "vid1", privacyStatus: "unlisted", approvalId: req.data.approvalId });
      expect(otherPrivacy.data.status).toBe("approval_mismatch");
      const otherUser = await call(b, "youtube_video_set_privacy", { videoId: "vid1", privacyStatus: "public", approvalId: req.data.approvalId });
      expect(otherUser.data.status).toBe("approval_mismatch");
      expect(fake.state.updates).toHaveLength(0);
      await a.close();
      await b.close();
    });

    it("a declined approval blocks the action for good", async () => {
      const client = await connect((await signIn("owner@example.com")).accessToken);
      fake.state.updates.length = 0;
      const req = await call(client, "youtube_video_set_privacy", { videoId: "vid1", privacyStatus: "unlisted" });
      await approveInBrowser(req.data.approvalUrl, "reject");
      const res = await call(client, "youtube_video_set_privacy", { videoId: "vid1", privacyStatus: "unlisted", approvalId: req.data.approvalId });
      expect(res.data.status).toBe("rejected_by_user");
      expect(fake.state.updates).toHaveLength(0);
      await client.close();
    });

    it("scheduling is publishing too, and shows the time in the owner's time zone", async () => {
      const client = await connect((await signIn("owner@example.com")).accessToken);
      fake.state.updates.length = 0;
      const publishAt = "2031-06-15T18:00:00+03:00";
      const req = await call(client, "youtube_video_schedule_publish", { videoId: "vid2", publishAt });
      expect(req.data.status).toBe("approval_required");
      expect(fake.state.updates).toHaveLength(0);
      const view = await approveInBrowser(req.data.approvalUrl);
      expect(view.html).toContain("Europe/Kyiv");
      expect(view.html).toContain("2031-06-15T15:00:00.000Z");

      const done = await call(client, "youtube_video_schedule_publish", { videoId: "vid2", publishAt, approvalId: req.data.approvalId });
      expect(done.isError).toBe(false);
      const sent = fake.state.updates[0]!.requestBody;
      expect(sent.status.privacyStatus).toBe("private");
      expect(sent.status.publishAt).toBe(publishAt);
      await client.close();
    });

    it("making a video private needs no approval", async () => {
      const client = await connect((await signIn("owner@example.com")).accessToken);
      fake.state.updates.length = 0;
      const res = await call(client, "youtube_video_set_privacy", { videoId: "vid1", privacyStatus: "private" });
      expect(res.isError).toBe(false);
      expect(fake.state.updates[0]!.requestBody.status.privacyStatus).toBe("private");
      await client.close();
    });

    it("escapes video titles on the approval page", async () => {
      const client = await connect((await signIn("owner@example.com")).accessToken);
      fake.state.title = `<script>alert("x")</script>`;
      const req = await call(client, "youtube_video_set_privacy", { videoId: "vid1", privacyStatus: "public" });
      fake.state.title = "My clip";
      const html = await (await fetch(req.data.approvalUrl)).text();
      expect(html).not.toContain("<script>alert");
      expect(html).toContain("&lt;script&gt;");
      await client.close();
    });

    it("approval pages refuse unknown ids and forged forms", async () => {
      expect((await fetch(`${BASE}/approve/does-not-exist`)).status).toBe(404);
      const client = await connect((await signIn("owner@example.com")).accessToken);
      const req = await call(client, "youtube_video_set_privacy", { videoId: "vid1", privacyStatus: "public" });
      const forged = await fetch(req.data.approvalUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ csrf: "forged", decision: "approve" }),
      });
      expect(forged.status).toBe(404);
      const crossSite = await fetch(req.data.approvalUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "Sec-Fetch-Site": "cross-site" },
        body: new URLSearchParams({ csrf: "x", decision: "approve" }),
      });
      expect(crossSite.status).toBe(403);
      await client.close();
    });
  });

  describe("uploads", () => {
    it("always create a PRIVATE video, run in the background and report progress", async () => {
      const client = await connect((await signIn("owner@example.com")).accessToken);
      fake.state.inserts.length = 0;

      const started = await call(client, "youtube_video_upload", {
        sourceUrl: "https://files.example.com/clip.mp4",
        title: "Phone clip",
        description: "hello",
        isShort: true,
      });
      expect(started.isError).toBe(false);
      const jobId: string = started.data.data.jobId;
      expect(jobId).toBeTruthy();

      let status: any;
      for (let i = 0; i < 50; i++) {
        status = (await call(client, "youtube_upload_status", { jobId })).data.data;
        if (status.status === "done" || status.status === "failed") break;
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(status.status).toBe("done");
      expect(status.video.id).toBe("newVid123");
      expect(status.video.privacyStatus).toBe("private");
      expect(status.video.url).toBe("https://youtu.be/newVid123");

      const insert = fake.state.inserts[0]!;
      expect(insert.bytes).toBe(MP4.length);
      expect(insert.request.requestBody.status.privacyStatus).toBe("private");
      expect(insert.request.requestBody.snippet.description).toMatch(/#Shorts$/);
      expect(insert.request.notifySubscribers).toBe(true);
      await client.close();
    });

    it("cannot be told to upload as public", async () => {
      const client = await connect((await signIn("owner@example.com")).accessToken);
      fake.state.inserts.length = 0;
      const res = await call(client, "youtube_video_upload", { sourceUrl: "https://files.example.com/clip.mp4", title: "x", privacyStatus: "public" });
      expect(res.isError).toBe(true);
      expect(JSON.stringify(res.data)).toMatch(/private/);
      expect(fake.state.inserts).toHaveLength(0);
      await client.close();
    });

    it("refuses links to internal addresses, plain http and local file paths", async () => {
      const client = await connect((await signIn("owner@example.com")).accessToken);
      for (const sourceUrl of [
        "https://169.254.169.254/latest/meta-data/", "https://127.0.0.1/v.mp4", "https://localhost/v.mp4",
        "https://app.railway.internal/v.mp4", "http://files.example.com/v.mp4",
      ]) {
        const res = await call(client, "youtube_video_upload", { sourceUrl, title: "x" });
        expect(res.isError, sourceUrl).toBe(true);
      }
      const local = await call(client, "youtube_video_upload", { filePath: "/etc/passwd", title: "x" });
      expect(local.isError).toBe(true);
      expect(fake.state.inserts).toHaveLength(0);
      await client.close();
    });

    it("upload jobs are private to the user who started them", async () => {
      const a = await connect((await signIn("owner@example.com")).accessToken);
      const b = await connect((await signIn("second@example.com")).accessToken);
      const started = await call(a, "youtube_video_upload", { sourceUrl: "https://files.example.com/clip.mp4", title: "Mine" });
      const peek = await call(b, "youtube_upload_status", { jobId: started.data.data.jobId });
      expect(peek.isError).toBe(true);
      expect(peek.data.error.code).toBe("JOB_NOT_FOUND");
      await a.close();
      await b.close();
    });
  });
});

describe("setup mode", () => {
  it("starts without crashing when settings are missing and shows what is needed (no secrets)", async () => {
    const app = createRemoteApp({
      config: { ...config, tokenEncryptionKey: undefined, allowedEmails: [], clientSecret: "" },
      createMcpServer: createServer,
    });
    const srv = await new Promise<Server>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    const base = `http://127.0.0.1:${(srv.address() as net.AddressInfo).port}`;
    const page = await (await fetch(base)).text();
    expect(page).toContain("TOKEN_ENCRYPTION_KEY");
    expect(page).toContain("ALLOWED_GOOGLE_EMAILS");
    expect(page).toContain("YOUTUBE_CLIENT_SECRET");
    expect(page).not.toContain("csecret");
    expect((await fetch(`${base}/health`)).status).toBe(200);
    const mcp = await fetch(`${base}/mcp`, { method: "POST" });
    expect(mcp.status).toBe(503);
    expect((await fetch(`${base}/.well-known/oauth-authorization-server`)).status).toBe(503);
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  });
});
