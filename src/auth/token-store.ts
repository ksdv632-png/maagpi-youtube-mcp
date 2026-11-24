import Conf from "conf";
import type { StoredTokens, ChannelProfile, MultiProfileStore } from "./types.js";

const EXPIRY_BUFFER_MS = 60_000;
const DEFAULT_PROFILE = "default";

type StoreShape = {
  tokens?: StoredTokens;
  profiles?: Record<string, ChannelProfile>;
  activeProfile?: string;
};

// Created lazily: the remote (HTTP) server never touches the local config directory.
let _store: Conf<StoreShape> | undefined;

function getStore(): Conf<StoreShape> {
  if (!_store) {
    _store = new Conf<StoreShape>({ projectName: "maagpi-youtube-mcp", projectVersion: "1" });
    migrate(_store);
  }
  return _store;
}

function migrate(store: Conf<StoreShape>): void {
  const legacyTokens = store.get("tokens");
  if (legacyTokens && !store.get("profiles")) {
    store.set("profiles", {
      [DEFAULT_PROFILE]: {
        name: DEFAULT_PROFILE,
        tokens: legacyTokens,
        addedAt: legacyTokens.stored_at ?? Date.now(),
      },
    });
    store.set("activeProfile", DEFAULT_PROFILE);
    store.delete("tokens");
  }
  if (!store.get("activeProfile")) {
    store.set("activeProfile", DEFAULT_PROFILE);
  }
}


export const tokenStore = {
  getActiveProfileName(): string {
    return getStore().get("activeProfile") ?? DEFAULT_PROFILE;
  },

  setActiveProfile(name: string): void {
    const profiles = getStore().get("profiles") ?? {};
    if (!profiles[name]) {
      throw new Error(`Profile "${name}" does not exist.`);
    }
    getStore().set("activeProfile", name);
  },

  listProfiles(): ChannelProfile[] {
    const profiles = getStore().get("profiles") ?? {};
    return Object.values(profiles);
  },

  getProfile(name: string): ChannelProfile | undefined {
    const profiles = getStore().get("profiles") ?? {};
    return profiles[name];
  },

  setProfile(name: string, tokens: StoredTokens, meta?: { channelId?: string; channelTitle?: string }): void {
    const profiles = getStore().get("profiles") ?? {};
    const existing = profiles[name];
    profiles[name] = {
      name,
      tokens,
      addedAt: existing?.addedAt ?? Date.now(),
      channelId: meta?.channelId ?? existing?.channelId,
      channelTitle: meta?.channelTitle ?? existing?.channelTitle,
    };
    getStore().set("profiles", profiles);
  },

  updateProfileMeta(name: string, meta: { channelId?: string; channelTitle?: string }): void {
    const profiles = getStore().get("profiles") ?? {};
    if (profiles[name]) {
      if (meta.channelId) profiles[name].channelId = meta.channelId;
      if (meta.channelTitle) profiles[name].channelTitle = meta.channelTitle;
      getStore().set("profiles", profiles);
    }
  },

  removeProfile(name: string): void {
    const profiles = getStore().get("profiles") ?? {};
    delete profiles[name];
    getStore().set("profiles", profiles);
    if (getStore().get("activeProfile") === name) {
      const remaining = Object.keys(profiles);
      getStore().set("activeProfile", remaining[0] ?? DEFAULT_PROFILE);
    }
  },

  // Convenience: get tokens for active profile (or named profile)
  get(profileName?: string): StoredTokens | undefined {
    const name = profileName ?? this.getActiveProfileName();
    return this.getProfile(name)?.tokens;
  },

  // Convenience: set tokens for active profile (or named profile)
  set(tokens: StoredTokens, profileName?: string): void {
    const name = profileName ?? this.getActiveProfileName();
    this.setProfile(name, tokens);
  },

  // Clear tokens for a profile (or active profile)
  clear(profileName?: string): void {
    const name = profileName ?? this.getActiveProfileName();
    this.removeProfile(name);
  },

  isExpired(tokens: StoredTokens): boolean {
    return tokens.expiry_date < Date.now() + EXPIRY_BUFFER_MS;
  },

  hasRefreshToken(profileName?: string): boolean {
    return !!this.get(profileName)?.refresh_token;
  },

  configPath(): string {
    return getStore().path;
  },
};
