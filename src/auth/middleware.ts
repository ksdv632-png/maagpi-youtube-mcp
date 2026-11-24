import { createHash } from "node:crypto";
import { OAuth2Client } from "google-auth-library";
import { config } from "../config.js";
import { getPrincipal, type RemotePrincipal } from "./context.js";
import { createAuthenticatedClient } from "./oauth.js";
import { tokenStore } from "./token-store.js";
import { YouTubeMcpError } from "../errors/types.js";
import { YouTubeMcpErrorCode } from "../errors/codes.js";

const _clients = new Map<string, OAuth2Client>();

/**
 * Remote mode: one OAuth2Client per connected Google account, built from the refresh token that
 * arrives (encrypted) inside the caller's bearer token. google-auth-library fetches and caches the
 * short-lived access tokens itself; nothing is written to disk.
 */
const _remoteClients = new Map<string, OAuth2Client>();
const MAX_REMOTE_CLIENTS = 20;

function remoteKey(p: RemotePrincipal): string {
  return createHash("sha256").update(`${p.sub}\n${p.googleRefreshToken}`).digest("hex");
}

function getRemoteClient(p: RemotePrincipal): OAuth2Client {
  const key = remoteKey(p);
  let client = _remoteClients.get(key);
  if (!client) {
    if (_remoteClients.size >= MAX_REMOTE_CLIENTS) _remoteClients.clear();
    client = new OAuth2Client({ clientId: config.clientId, clientSecret: config.clientSecret });
    client.setCredentials({ refresh_token: p.googleRefreshToken });
    _remoteClients.set(key, client);
  }
  return client;
}

export async function getAuthClient(channel?: string): Promise<OAuth2Client> {
  const principal = getPrincipal();
  if (principal) return getRemoteClient(principal);
  const profileName = channel ?? tokenStore.getActiveProfileName();
  const stored = tokenStore.get(profileName);
  if (_clients.has(profileName) && stored && tokenStore.isExpired(stored)) {
    _clients.delete(profileName);
  }
  if (!_clients.has(profileName)) {
    const client = await createAuthenticatedClient(profileName);
    _clients.set(profileName, client);
  }
  return _clients.get(profileName)!;
}

export function resetAuthClient(channel?: string): void {
  const principal = getPrincipal();
  if (principal) {
    _remoteClients.delete(remoteKey(principal));
    return;
  }
  if (channel) {
    _clients.delete(channel);
  } else {
    _clients.delete(tokenStore.getActiveProfileName());
  }
}

export function resetAllAuthClients(): void {
  _clients.clear();
  _remoteClients.clear();
}

export async function withAuthRetry<T>(fn: (auth: OAuth2Client) => Promise<T>, channel?: string): Promise<T> {
  const auth = await getAuthClient(channel);
  try {
    return await fn(auth);
  } catch (err) {
    if (
      err instanceof YouTubeMcpError &&
      (err.code === YouTubeMcpErrorCode.AUTH_TOKEN_EXPIRED ||
        err.code === YouTubeMcpErrorCode.AUTH_REQUIRED)
    ) {
      resetAuthClient(channel);
      const freshAuth = await getAuthClient(channel);
      return fn(freshAuth);
    }
    throw err;
  }
}
