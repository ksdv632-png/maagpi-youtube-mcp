import { AsyncLocalStorage } from "node:async_hooks";

/**
 * The authenticated caller of a remote MCP request.
 * Set by the HTTP layer after the bearer token has been verified; read by the
 * YouTube auth middleware and by anything that must be scoped per user
 * (response cache, approvals, upload jobs).
 */
export interface RemotePrincipal {
  /** Google account id (`sub`). */
  sub: string;
  email: string;
  /** Google refresh token carried (encrypted) inside the bearer token. Never log. */
  googleRefreshToken: string;
  /** OAuth client id that obtained the token. */
  clientId: string;
  /** Scopes granted by Google. */
  googleScope: string;
}

const storage = new AsyncLocalStorage<RemotePrincipal>();

export function runWithPrincipal<T>(principal: RemotePrincipal, fn: () => T): T {
  return storage.run(principal, fn);
}

export function getPrincipal(): RemotePrincipal | undefined {
  return storage.getStore();
}
