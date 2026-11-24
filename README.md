# maagpi-youtube-mcp

![MCP](https://img.shields.io/badge/MCP-compatible-green)
![npm](https://img.shields.io/npm/v/maagpi-youtube-mcp)
![node](https://img.shields.io/badge/node-%3E%3D18-blue)

**maagpi-youtube-mcp** is a full YouTube channel-management MCP server: upload videos and Shorts from cloud storage, edit titles/descriptions/tags/covers, manage playlists, update channel settings, read analytics, answer comments and schedule publishing — from any MCP-compatible AI client, including **Claude on your phone** (remote custom connector) — with safety rails: **no video deletion** and **publishing only after your approval**.

Wraps the official YouTube Data API v3 + YouTube Analytics API behind a single MCP surface with built-in OAuth, quota tracking, response caching, and structured error handling.

## Two ways to run it

| Mode | For | Transport | Auth |
|---|---|---|---|
| **Remote** (new) | Claude on iPhone / web / desktop as a *custom connector*, no computer needed | Streamable HTTP, deployed on **Railway** | Claude ⇄ this server: OAuth 2.1 (DCR + PKCE). This server ⇄ Google: OAuth 2.0 web flow |
| **Local** | Claude Desktop / Code / Cursor … on your own machine | stdio (default) | Google OAuth in a local browser, tokens in your OS config dir |

➡️ **Phone-only setup, step by step (Ukrainian): [docs/SETUP_UK.md](docs/SETUP_UK.md)**

## Remote mode (Railway + Claude custom connector)

```
iPhone (Claude app) ──▶ Claude ──HTTPS──▶ this server on Railway ──▶ YouTube Data / Analytics APIs
                                   │            ▲
                                   └─ sign-in ──┴── Google OAuth (the account that owns the channel)
```

* **No database, no volume.** Every token the server issues (OAuth client ids, codes, access/refresh tokens, `state`) is an AES-256-GCM sealed blob. The Google refresh token travels *inside* Claude's (encrypted) token. The only secret you store is `TOKEN_ENCRYPTION_KEY` (a Railway variable). Redeploys never log you out.
* **Only your Google account can sign in** (`ALLOWED_GOOGLE_EMAILS`). The YouTube channel may live on a different Google account than your Railway/GitHub/Claude accounts — just sign in with the account that owns the channel.
* **Nothing secret is in Git.** Credentials live only in Railway variables.

### Deploy

1. Railway → *New Project → Deploy from GitHub repo* → pick this repository (the `Dockerfile` and `railway.json` are picked up automatically).
2. *Settings → Networking → Generate Domain*. Open `https://<your-domain>/` — the status page lists the variables that are still missing, shows the exact **Redirect URI** for Google and generates a **`TOKEN_ENCRYPTION_KEY`** for you.
3. Google Cloud Console: enable **YouTube Data API v3** and **YouTube Analytics API**; create an **OAuth client ID of type "Web application"** with the redirect URI from the status page; set the consent screen's publishing status to **In production** (otherwise Google expires the sign-in after 7 days; you do *not* need to submit for verification — you will just click through the "unverified app" warning once).
4. Railway → Variables: `YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET`, `TOKEN_ENCRYPTION_KEY`, `ALLOWED_GOOGLE_EMAILS`.
5. Claude → *Settings → Connectors → Add custom connector* → URL `https://<your-domain>/mcp` → connect → sign in with the Google account that owns the channel.

### Safety rules enforced by the server

| Rule | How it is enforced |
|---|---|
| **Videos cannot be deleted** | There is no delete-video tool at all (not even behind a flag). Other deletions (playlists, comments, homepage sections) exist only if you set `YOUTUBE_MCP_ALLOW_DESTRUCTIVE=true`. |
| **Publishing only after your confirmation** | Uploads are always created **private**. `youtube_video_set_privacy` (public/unlisted) and `youtube_video_schedule_publish` first return an *approval link*. You open it on your phone and tap **Approve**; only then the next tool call runs. The approval is one-time, expires in 30 min, and is bound to your account, the video and the exact action. The model cannot press the button for you. |
| **Only your account** | Google sign-in is checked against `ALLOWED_GOOGLE_EMAILS` (and optionally `YOUTUBE_CHANNEL_ID`). |
| **No server file access** | Local file-path parameters do not exist remotely. Videos/images are fetched from `https` links by the server (SSRF-protected: public addresses only, checked at connect time and on every redirect; size-limited; file type verified by magic bytes). |
| **Least privilege** | Google scopes: `youtube`, `youtube.force-ssl`, `youtube.upload`, `yt-analytics.readonly`, `yt-analytics-monetary.readonly` (+ `openid email`). The old `youtubepartner` scope is no longer requested. |
| **Read vs write** | Every tool carries MCP annotations (`readOnlyHint`, `destructiveHint`, …) so Claude can group them and ask before write actions. |

### Uploading from cloud storage

`youtube_video_upload` takes `sourceUrl`: a link to an MP4/MOV (WebM also works) that the **server downloads and streams straight to YouTube** (nothing is stored on Railway). Works with:

* **Google Drive** — share the file as *Anyone with the link* and paste the link (converted automatically)
* **Dropbox** — shared link (converted automatically)
* any **direct https link** or pre-signed URL (S3, R2, GCS …)

Not supported: iCloud links (no direct-download URL) and OneDrive/SharePoint *page* links. Because large uploads outlive a chat request, the tool returns a `jobId` immediately; poll `youtube_upload_status`.

### Publishing limits & features the YouTube API does not offer

> ⚠️ **Unaudited API projects:** Google locks videos uploaded through `videos.insert` by an API project that has not passed the *YouTube API Services audit* as **private**. If a video you published through this server stays private, apply for the audit/quota-extension form (free) in Google Cloud / the YouTube API documentation, or publish that video manually in YouTube Studio. The server warns when YouTube keeps a video private. (This restriction comes from Google, not from this server.)

Not possible through the official API (so the server cannot do it): change the **channel name, @handle or avatar**; create **Premieres**; **pin/heart comments**; set **playlist cover images**; edit **end screens / cards**; make a video a "Short" with a flag (a Short is simply a vertical/square video of up to 3 minutes — `isShort` only adds `#Shorts`). Custom thumbnails need a phone-verified channel. YouTube Analytics does not expose every Studio metric (e.g. impressions/CTR may be unavailable). The daily Data API quota is 10,000 units (an upload costs 1,600).

> The limits above are documented Google API behaviour as of writing; double-check against the [official docs](https://developers.google.com/youtube/v3) if Google changed something.

## Local mode (stdio)

Local mode uses a Google OAuth client of type **Desktop app**; the server opens a browser window for consent and stores refresh tokens under named **profiles** (one per channel) in your OS config directory. Add more channels with `youtube_account_add`. The safety rules above apply here too (no video deletion; uploads are private; publishing needs `confirmPublish: true`, which the assistant must only pass after you said yes).

### One-time Google Cloud setup

1. [Google Cloud Console](https://console.cloud.google.com/) → **APIs & Services → Library** → enable **YouTube Data API v3** and **YouTube Analytics API**.
2. **OAuth consent screen** → External → add your account as a **Test user** (or publish "In production").
3. **Credentials → Create Credentials → OAuth client ID** → **Desktop app** → copy the Client ID and Secret.

> Keep your Client Secret out of source control.

## Quick Connect (local mode)

Pick your client and drop the snippet into the corresponding config file. Replace `your_client_id` / `your_client_secret` with your Google OAuth credentials.

### Claude Desktop

`~/Library/Application Support/Claude/claude_desktop_config.json` (macOS)
`%APPDATA%\Claude\claude_desktop_config.json` (Windows)

```json
{
  "mcpServers": {
    "youtube": {
      "command": "npx",
      "args": ["-y", "maagpi-youtube-mcp"],
      "env": {
        "YOUTUBE_CLIENT_ID": "your_client_id",
        "YOUTUBE_CLIENT_SECRET": "your_client_secret"
      }
    }
  }
}
```

### Claude Code

`~/.claude/settings.json`

```json
{
  "mcpServers": {
    "youtube": {
      "command": "npx",
      "args": ["-y", "maagpi-youtube-mcp"],
      "env": {
        "YOUTUBE_CLIENT_ID": "your_client_id",
        "YOUTUBE_CLIENT_SECRET": "your_client_secret"
      }
    }
  }
}
```

Or via the Claude Code CLI:

```bash
claude mcp add youtube -- npx -y maagpi-youtube-mcp \
  -e YOUTUBE_CLIENT_ID=your_client_id \
  -e YOUTUBE_CLIENT_SECRET=your_client_secret
```

### Cursor

`~/.cursor/mcp.json`

```json
{
  "mcpServers": {
    "youtube": {
      "command": "npx",
      "args": ["-y", "maagpi-youtube-mcp"],
      "env": {
        "YOUTUBE_CLIENT_ID": "your_client_id",
        "YOUTUBE_CLIENT_SECRET": "your_client_secret"
      }
    }
  }
}
```

### Windsurf

`~/.codeium/windsurf/mcp_config.json`

```json
{
  "mcpServers": {
    "youtube": {
      "command": "npx",
      "args": ["-y", "maagpi-youtube-mcp"],
      "env": {
        "YOUTUBE_CLIENT_ID": "your_client_id",
        "YOUTUBE_CLIENT_SECRET": "your_client_secret"
      }
    }
  }
}
```

### VS Code (MCP-compatible extensions)

`.vscode/mcp.json` (workspace) or User Settings:

```json
{
  "servers": {
    "youtube": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "maagpi-youtube-mcp"],
      "env": {
        "YOUTUBE_CLIENT_ID": "your_client_id",
        "YOUTUBE_CLIENT_SECRET": "your_client_secret"
      }
    }
  }
}
```

### Zed

`~/.config/zed/settings.json`

```json
{
  "context_servers": {
    "youtube": {
      "command": {
        "path": "npx",
        "args": ["-y", "maagpi-youtube-mcp"],
        "env": {
          "YOUTUBE_CLIENT_ID": "your_client_id",
          "YOUTUBE_CLIENT_SECRET": "your_client_secret"
        }
      }
    }
  }
}
```

### mcporter

```bash
mcporter add youtube --command "npx -y maagpi-youtube-mcp" \
  --env YOUTUBE_CLIENT_ID=your_client_id \
  --env YOUTUBE_CLIENT_SECRET=your_client_secret

mcporter call youtube youtube_account_list '{}'
```

### Streamable HTTP

Use [Remote mode](#remote-mode-railway--claude-custom-connector) for anything reachable from the internet. Locally you can run `npm run build && npm start` (needs the remote variables from `.env.example`; set `PUBLIC_URL=http://127.0.0.1:3000` for a local test) and open `http://127.0.0.1:3000/` for the status page.

## Tool Reference

> **Local mode** tools also accept an optional `channel` parameter (profile name). **Remote mode** has exactly one channel (the account you signed in with), so the parameter does not exist there.

### Account Management

| Tool | Mode | Parameters | Description |
|---|---|---|---|
| `youtube_account_current` | both | _none_ | Remote: shows the connected Google account and YouTube channel. Local: the active profile |
| `youtube_account_add` | local | `name` | Connect a new channel via OAuth, save as a named profile |
| `youtube_account_list` | local | _none_ | List all connected profiles |
| `youtube_account_switch` | local | `name` | Set the default active profile |
| `youtube_account_remove` | local | `name`, `confirm: true` | Disconnect and remove a profile |

### Videos

| Tool | Parameters | Quota |
|---|---|---|
| `youtube_video_upload` | `sourceUrl` (https link; local mode also `filePath`), `title`, `description?`, `tags?`, `categoryId?`, `language?`, `isShort?`, `madeForKids?`, `notifySubscribers?`, `thumbnailUrl?` — **always uploads as private**, runs in the background, returns `jobId` | 1600 |
| `youtube_upload_status` | `jobId?` (omit to list recent uploads) | 0 |
| `youtube_video_get` | `videoId`, `parts?` | 1 |
| `youtube_video_list` | `playlistId?`, `query?`, `channelId?`, `maxResults?`, `pageToken?` — own videos (incl. private/scheduled) via the uploads playlist | 2 (search: 100) |
| `youtube_video_update` | `videoId`, `title?`, `description?`, `tags?`, `categoryId?`, `defaultLanguage?` | 50 |
| `youtube_video_rate` | `videoId`, `rating` (`like`/`dislike`/`none`) | 50 |
| `youtube_video_set_thumbnail` | `videoId`, `thumbnailUrl` (local: or `thumbnailPath`) | 50 |

There is **no tool to delete a video**.

### Publishing (needs your approval)

| Tool | Parameters | Quota |
|---|---|---|
| `youtube_video_set_privacy` | `videoId`, `privacyStatus`, `approvalId?` — `private` is immediate; `public`/`unlisted` need approval | 50 (+1) |
| `youtube_video_schedule_publish` | `videoId`, `publishAt` (future ISO 8601 **with offset**), `approvalId?` | 50 (+1) |

Flow: the first call returns `{"status":"approval_required","approvalUrl":"…"}` and changes nothing → open the link, tap **Approve** → the assistant repeats the call with `approvalId`. (Local mode: pass `confirmPublish: true` after the user agreed.) `youtube_video_set_premiere` was removed: the API cannot create Premieres (it only ever scheduled a normal publish).

### Analytics

| Tool | Parameters | Quota |
|---|---|---|
| `youtube_analytics_video_metrics` | `videoId`, `startDate`, `endDate`, `metrics[]`, `dimensions?` | 1 |
| `youtube_analytics_channel_metrics` | `startDate`, `endDate`, `metrics[]`, `dimensions?`, `filters?` | 1 |
| `youtube_analytics_top_videos` | `startDate`, `endDate`, `metric`, `maxResults?` | 1 |
| `youtube_analytics_audience_retention` | `videoId`, `startDate`, `endDate` | 1 |
| `youtube_analytics_revenue_report` | `startDate`, `endDate`, `dimensions?` | 1 |

Dates use `YYYY-MM-DD`. Common metrics: `views`, `estimatedMinutesWatched`, `averageViewDuration`, `averageViewPercentage`, `likes`, `comments`, `shares`, `subscribersGained`, `subscribersLost`; revenue metrics need a monetised channel.

### Comments

| Tool | Parameters | Quota |
|---|---|---|
| `youtube_comment_list` | `videoId?` (omit = latest comments across the whole channel), `maxResults?`, `order?`, `searchTerms?`, `pageToken?` | 1 (+1) |
| `youtube_comment_thread_get` | `commentThreadId`, `maxReplies?` | 1 |
| `youtube_comment_reply` | `parentCommentId`, `text` | 50 |
| `youtube_comment_moderate` | `commentId`, `moderationStatus` (`published`/`heldForReview`/`rejected`), `banAuthor?` | 50 |
| `youtube_comment_delete`¹ | `commentId` | 50 |

### Playlists

| Tool | Parameters | Quota |
|---|---|---|
| `youtube_playlist_create` | `title`, `privacyStatus`, `description?` | 50 |
| `youtube_playlist_update` | `playlistId`, `title?`, `description?`, `privacyStatus?` | 50 |
| `youtube_playlist_get` | `playlistId` | 1 |
| `youtube_playlist_list` | `channelId?`, `maxResults?` | 1 |
| `youtube_playlist_item_add` | `playlistId`, `videoId`, `position?` | 50 |
| `youtube_playlist_item_remove` | `playlistItemId` | 50 |
| `youtube_playlist_item_reorder` | `playlistItemId`, `playlistId`, `newPosition` | 50 |
| `youtube_playlist_items_list` | `playlistId`, `maxResults?` | 1 |
| `youtube_playlist_delete`¹ | `playlistId`, `confirm: true` | 50 |

### Channel Management

| Tool | Parameters | Quota |
|---|---|---|
| `youtube_channel_get` | `parts?` | 1 |
| `youtube_channel_update` | `description?`, `keywords?`, `country?`, `defaultLanguage?` | 51 |
| `youtube_channel_branding_update` | `showRelatedChannels?`, `featuredChannelsTitle?`, `featuredChannelsUrls?`, `unsubscribedTrailer?`, `moderateComments?`, `trackingAnalyticsAccountId?` | 51 |
| `youtube_channel_banner_set` | `imageUrl` (JPG/PNG ≥ 2048×1152, ≤ 6 MB) | 101 |
| `youtube_channel_watermark_set` | `imageUrl`, `position?`, `timing?` | 51 |
| `youtube_channel_watermark_unset` | _none_ | 51 |
| `youtube_channel_section_list` | `channelId?` | 1 |
| `youtube_channel_section_create` | `type`, `title?`, `playlistIds?` | 50 |
| `youtube_channel_section_delete`¹ | `sectionId` | 50 |

¹ Only registered when `YOUTUBE_MCP_ALLOW_DESTRUCTIVE=true`.

The channel **name, @handle and avatar cannot be changed through the YouTube API** (change them in the YouTube app / Studio).

## Example Prompts

```
Upload this video as a Short, title "Morning routine", description "…", tags [vlog]:
https://drive.google.com/file/d/…/view     (then show me when it is done)
```

```
Set the cover of that video to https://www.dropbox.com/scl/fi/…/cover.jpg
```

```
Schedule video dQw4w9WgXcQ to go public on 20 January 2027 at 18:00 Kyiv time.
(Claude replies with an approval link — open it and tap Approve.)
```

```
Show my top 5 videos by views for the last 28 days, and the revenue per day this month.
```

```
Show the newest comments on my channel and suggest replies. Post them only after I say OK.
```

> Anything that makes a video visible needs your tap on the approval link. Videos cannot be deleted.

## Multiple Channels (local mode)

Connect any number of YouTube accounts and target any of them from any tool via the optional `channel` parameter — no switching required.

```
Add a new YouTube channel profile named "gaming"
List all my connected YouTube channel profiles
Switch my active YouTube profile to "gaming"
Upload /videos/clip.mp4 to my "gaming" channel, title "EP1", public
```

CLI auth for a named profile (handy for headless setups):

```bash
npm run auth -- --channel gaming
```

## Quota

YouTube Data API v3 grants **10,000 units/day** by default. Every tool response includes a `quota` field:

```json
{
  "quota": {
    "used": 151,
    "budget": 9000,
    "remaining": 8849,
    "resetAt": "2026-01-15T08:00:00.000Z",
    "warningLevel": "ok",
    "costOfThisCall": 1
  }
}
```

`warningLevel`: `"ok"` → `"warn"` at 80% → `"critical"` at 95%.

**Built-in protections**

- GET responses are cached (videos 60s, channels 5min, analytics 5min) — repeat reads cost 0 quota
- Writes auto-retry on 429/5xx with exponential backoff (up to 3×)
- Set `YOUTUBE_MCP_QUOTA_LIMIT` below 10,000 to leave headroom

## Error Format

All errors are returned as structured tool content — agents can read and act on them without crashing:

```json
{
  "success": false,
  "error": {
    "code": "QUOTA_EXCEEDED",
    "message": "YouTube API daily quota has been exceeded.",
    "suggestedFix": "Wait for quota reset at midnight Pacific Time, or increase your quota in Google Cloud Console.",
    "retryable": false,
    "docsUrl": "https://developers.google.com/youtube/v3/getting-started#quota"
  },
  "quota": { "used": 9001, "warningLevel": "critical" }
}
```

| Code | Meaning |
|---|---|
| `AUTH_REQUIRED` | No stored tokens — OAuth flow needed |
| `AUTH_TOKEN_EXPIRED` | Token expired and refresh failed — re-authenticate |
| `AUTH_INSUFFICIENT_SCOPE` | Missing OAuth scope — delete tokens and re-auth |
| `QUOTA_EXCEEDED` | Daily quota exhausted — wait for midnight PT reset |
| `PERMISSION_DENIED` | Resource not owned by authenticated account |
| `VIDEO_NOT_FOUND` | Video ID doesn't exist or isn't accessible |
| `PLAYLIST_NOT_FOUND` | Playlist ID not found |
| `RATE_LIMITED` | Temporary rate limit — server retries automatically |
| `INVALID_PARAMS` | Zod validation failed — check parameter types |
| `PUBLISH_DATE_IN_PAST` | `publishAt` must be a future datetime |
| `DOWNLOAD_FAILED` | The cloud link could not be downloaded (not shared publicly, redirected to a private address, …) |
| `UNSUPPORTED_MEDIA` | The link is a web page or not an MP4/MOV/WebM video (or JPG/PNG/GIF image) |
| `FILE_TOO_LARGE` | The file exceeds `MAX_UPLOAD_MB` (or the 2 MB thumbnail / 6 MB banner limit) |
| `JOB_NOT_FOUND` | Unknown upload job id (or the server restarted) |
| `AUTH_REFRESH_FAILED` | Google revoked/expired the sign-in — reconnect the connector in Claude |

## Environment Variables

| Variable | Mode | Default | Description |
|---|---|---|---|
| `YOUTUBE_CLIENT_ID` / `YOUTUBE_CLIENT_SECRET` | both (required) | — | Google OAuth client (remote: type *Web application*; local: *Desktop app*) |
| `TOKEN_ENCRYPTION_KEY` | remote (required) | — | ≥ 32 random characters; encrypts all issued tokens. Changing it signs everyone out |
| `ALLOWED_GOOGLE_EMAILS` | remote (required) | — | Comma-separated Google accounts allowed to sign in |
| `PUBLIC_URL` | remote | `https://$RAILWAY_PUBLIC_DOMAIN` | Public https address of the server |
| `YOUTUBE_CHANNEL_ID` | remote | — | Refuse to connect any channel but this one |
| `DISPLAY_TIMEZONE` | remote | `Europe/Kyiv` | Time zone shown on the approval page and told to the assistant |
| `UI_LANGUAGE` | remote | `uk` | `uk` or `en` for the status/approval pages |
| `MAX_UPLOAD_MB` | remote | `2048` | Largest video the server will relay |
| `ALLOWED_DOWNLOAD_HOSTS` | remote | _any public host_ | Comma-separated hosts (and subdomains) allowed for `sourceUrl`/image links |
| `ALLOWED_ORIGINS` | remote | `https://claude.ai,https://claude.com` + yours | Browser origins that may call `/mcp` (server-to-server calls have no origin) |
| `ALLOWED_REDIRECT_URIS` | remote | Claude's callbacks | Extra OAuth redirect URIs a connector may register |
| `YOUTUBE_MCP_ALLOW_DESTRUCTIVE` | both | `false` | Also expose playlist/comment/section deletion (never video deletion) |
| `PORT` / `YOUTUBE_MCP_HTTP_PORT` | remote | `3000` | HTTP port (Railway sets `PORT`) |
| `YOUTUBE_MCP_HTTP_HOST` | remote | `0.0.0.0` if `PORT` is set, else `127.0.0.1` | Bind address |
| `YOUTUBE_MCP_TRANSPORT` | both | `stdio` | `stdio` or `http` (`--http` flag does the same) |
| `YOUTUBE_MCP_QUOTA_LIMIT` | both | `9000` | Daily quota warning threshold |
| `YOUTUBE_MCP_CACHE_TTL` | both | per-resource | Override all cache TTLs (ms) |
| `YOUTUBE_MCP_LOG_LEVEL` | both | `info` | `error` \| `warn` \| `info` \| `debug` |

If a required remote variable is missing the server does **not** crash: it starts in *setup mode* and `/` shows what is missing (names only, never values).

## Security notes

* Credentials are only ever read from the environment — nothing secret is committed (`.env*` is git-ignored; CI runs without secrets).
* Logs and error messages are scrubbed of tokens (`ya29…`, refresh tokens, bearer tokens, sealed tokens).
* OAuth: PKCE (S256) required, redirect URIs restricted to Claude's callbacks (+ loopback), authorization codes are single-use and live 2 minutes, tokens are bound to this server's `/mcp` resource (RFC 8707) and to a purpose (a refresh token cannot be used as an access token), Google sign-in is protected against login-CSRF with a `SameSite=Lax` cookie, `Origin` of `/mcp` requests is validated, request bodies are size-limited, auth endpoints are rate-limited.
* The response cache is keyed per Google account.
* Production dependency audit: `npm audit --omit=dev` is clean for the MCP SDK/Express stack; remaining low-risk advisories are transitive (`uuid` inside Google's client libraries, `zod` v3 — mitigated by bounded inputs and the 512 kB body limit). Upgrading them needs a major bump of the Google client libraries / Zod.
* A restart forgets in-memory state only: pending approvals and background-upload jobs (Claude's connection survives). Run a single replica.

## Development

```bash
npm install
npm run dev          # run with tsx (requires .env)
npm run build && npm start   # remote server (needs the remote variables)
npm run test:integration     # end-to-end test of the remote server (fake Google + fake YouTube)
npm run auth         # authenticate the default channel profile (local mode)
npm run auth -- --channel gaming   # authenticate a named profile
npm run typecheck    # tsc --noEmit
npm test             # vitest unit tests
npm run build        # production bundle → dist/index.js
npm pack --dry-run   # verify publish artifact
```

## Why maagpi-youtube-mcp 🎯

- **Operate YouTube from your phone** — remote connector for Claude (iPhone/web/desktop) plus local stdio for Cursor, Windsurf, Zed, VS Code, mcporter
- **Manage multiple channels at once** — no context switching, target any channel per call
- **Production-grade plumbing** — OAuth, refresh tokens, quota tracking, retries, structured errors
- **Full surface coverage** — videos, scheduling, analytics, comments, playlists, branding

## Links

- npm: https://www.npmjs.com/package/maagpi-youtube-mcp
- YouTube Data API: https://developers.google.com/youtube/v3
- YouTube Analytics API: https://developers.google.com/youtube/analytics
- Model Context Protocol: https://modelcontextprotocol.io
