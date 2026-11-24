import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import { InvalidClientMetadataError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { TokenCrypto } from "./crypto.js";

/**
 * Redirect URIs a client may register.
 *  - Claude (web, desktop and the iPhone app all use the claude.ai/claude.com callback)
 *  - loopback http (RFC 8252) for Claude Code / MCP Inspector on the owner's own computer
 * Anything else is rejected, so the authorization code can only ever be delivered to
 * those places. Extra URIs can be added with ALLOWED_REDIRECT_URIS.
 */
export const DEFAULT_REDIRECT_URIS = [
  "https://claude.ai/api/mcp/auth_callback",
  "https://claude.com/api/mcp/auth_callback",
];

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function isAllowedRedirectUri(uri: string, extra: string[] = []): boolean {
  if (DEFAULT_REDIRECT_URIS.includes(uri) || extra.includes(uri)) return true;
  try {
    const u = new URL(uri);
    return u.protocol === "http:" && LOOPBACK.has(u.hostname) && !u.hash;
  } catch {
    return false;
  }
}

interface ClientPayload {
  ru: string[];
  m: "none" | "client_secret_post";
  n?: string;
}

const CLIENT_TTL_SECONDS = 365 * 24 * 3600;

/**
 * Dynamic Client Registration without a database: the client_id *is* a sealed token that
 * carries the registered redirect URIs. Registration is therefore free of server state.
 */
export class StatelessClientsStore implements OAuthRegisteredClientsStore {
  constructor(
    private readonly crypto: TokenCrypto,
    private readonly extraRedirectUris: string[] = []
  ) {}

  getClient(clientId: string): OAuthClientInformationFull | undefined {
    const p = this.crypto.open<ClientPayload>("client", clientId);
    if (!p) return undefined;
    const info: OAuthClientInformationFull = {
      client_id: clientId,
      client_id_issued_at: p.iat,
      redirect_uris: p.ru,
      token_endpoint_auth_method: p.m,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      client_name: p.n,
    };
    if (p.m === "client_secret_post") {
      info.client_secret = this.crypto.mac("client-secret", clientId);
      info.client_secret_expires_at = 0;
    }
    return info;
  }

  registerClient(
    client: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">
  ): OAuthClientInformationFull {
    const uris = (client.redirect_uris ?? []).map(String);
    if (uris.length === 0 || uris.length > 5) {
      throw new InvalidClientMetadataError("redirect_uris must contain between 1 and 5 URIs");
    }
    for (const uri of uris) {
      if (!isAllowedRedirectUri(uri, this.extraRedirectUris)) {
        throw new InvalidClientMetadataError(`redirect_uri is not allowed: ${uri.slice(0, 200)}`);
      }
    }
    const method = client.token_endpoint_auth_method === "client_secret_post" ? "client_secret_post" : "none";
    const payload: ClientPayload = {
      ru: uris,
      m: method,
      n: client.client_name?.slice(0, 80),
    };
    const clientId = this.crypto.seal("client", payload, CLIENT_TTL_SECONDS);
    const registered = this.getClient(clientId);
    if (!registered) throw new InvalidClientMetadataError("could not register client");
    return registered;
  }
}
