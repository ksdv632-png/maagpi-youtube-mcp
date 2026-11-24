import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getPrincipal } from "../auth/context.js";
import { createAuthenticatedClient } from "../auth/oauth.js";
import { tokenStore } from "../auth/token-store.js";
import { getAuthClient, resetAllAuthClients } from "../auth/middleware.js";
import { buildYouTubeClient } from "../youtube/client.js";
import { getChannel } from "../youtube/channels.js";
import { YouTubeMcpError } from "../errors/types.js";
import { buildErrorResponse, toMcpError } from "../errors/handlers.js";
import { YouTubeMcpErrorCode } from "../errors/codes.js";
import { getQuotaSummary } from "../quota/tracker.js";
import {
  AddChannelSchema, SwitchChannelSchema, RemoveChannelSchema,
  ListChannelsSchema, CurrentChannelSchema,
} from "../schemas/account.js";
import { isRemote } from "../config.js";
import { toolResult } from "./result.js";

export function registerAccountTools(server: McpServer): void {
  if (isRemote) {
    // The remote server has exactly one identity: the Google account the owner signed in with.
    server.registerTool(
      "youtube_account_current",
      {
        description:
          "Show which Google account and YouTube channel this connector is acting on. Call it first if the user is unsure which channel is connected.",
        inputSchema: CurrentChannelSchema,
      },
      async () => {
        try {
          const principal = getPrincipal();
          const auth = await getAuthClient();
          const channel = await getChannel(buildYouTubeClient(auth), ["id", "snippet", "statistics"]);
          return toolResult({
            success: true,
            data: {
              googleAccount: principal?.email,
              channelId: channel?.id,
              channelTitle: channel?.snippet?.title,
              customUrl: channel?.snippet?.customUrl,
              subscribers: channel?.statistics?.subscriberCount,
              videos: channel?.statistics?.videoCount,
            },
          });
        } catch (err) {
          return toolResult(buildErrorResponse(toMcpError(err), getQuotaSummary(0)));
        }
      }
    );
    return;
  }

  // ── Local (stdio) multi-profile management ────────────────────────────────
  server.registerTool(
    "youtube_account_add",
    {
      description: "Connect a new YouTube channel by running the OAuth flow and saving it under a named profile. After this you can target it with channel: '<name>' in any tool.",
      inputSchema: AddChannelSchema,
    },
    async (params) => {
      try {
        const existing = tokenStore.getProfile(params.name);
        if (existing) {
          throw new YouTubeMcpError(
            YouTubeMcpErrorCode.INTERNAL_ERROR,
            `Profile "${params.name}" already exists. Remove it first or choose a different name.`
          );
        }

        const client = await createAuthenticatedClient(params.name);
        const yt = buildYouTubeClient(client);
        const channelData = await getChannel(yt, ["id", "snippet"]);

        if (channelData?.id) {
          tokenStore.updateProfileMeta(params.name, {
            channelId: channelData.id,
            channelTitle: (channelData as { snippet?: { title?: string } }).snippet?.title,
          });
        }

        const profile = tokenStore.getProfile(params.name);
        return toolResult({
          success: true,
          data: {
            name: params.name,
            channelId: profile?.channelId,
            channelTitle: profile?.channelTitle,
            addedAt: profile?.addedAt,
            message: `Channel "${params.name}" connected. Use channel: "${params.name}" in any tool to target it.`,
          },
        });
      } catch (err) {
        return toolResult(buildErrorResponse(toMcpError(err), getQuotaSummary(0)));
      }
    }
  );

  server.registerTool(
    "youtube_account_list",
    {
      description: "List all connected YouTube channel profiles with their names, channel IDs, and active status.",
      inputSchema: ListChannelsSchema,
    },
    async () => {
      try {
        const profiles = tokenStore.listProfiles();
        const active = tokenStore.getActiveProfileName();
        const data = profiles.map((p) => ({
          name: p.name,
          channelId: p.channelId,
          channelTitle: p.channelTitle,
          addedAt: p.addedAt ? new Date(p.addedAt).toISOString() : undefined,
          active: p.name === active,
        }));
        return toolResult({ success: true, data, activeProfile: active });
      } catch (err) {
        return toolResult(buildErrorResponse(toMcpError(err), getQuotaSummary(0)));
      }
    }
  );

  server.registerTool(
    "youtube_account_switch",
    {
      description: "Switch the active channel profile. All tools without an explicit channel parameter will use this profile.",
      inputSchema: SwitchChannelSchema,
    },
    async (params) => {
      try {
        tokenStore.setActiveProfile(params.name);
        resetAllAuthClients();
        const profile = tokenStore.getProfile(params.name);
        return toolResult({
          success: true,
          data: {
            activeProfile: params.name,
            channelId: profile?.channelId,
            channelTitle: profile?.channelTitle,
            message: `Switched to profile "${params.name}". All subsequent tool calls will use this channel.`,
          },
        });
      } catch (err) {
        return toolResult(buildErrorResponse(toMcpError(err), getQuotaSummary(0)));
      }
    }
  );

  server.registerTool(
    "youtube_account_current",
    {
      description: "Show the currently active channel profile.",
      inputSchema: CurrentChannelSchema,
    },
    async () => {
      try {
        const active = tokenStore.getActiveProfileName();
        const profile = tokenStore.getProfile(active);
        return toolResult({
          success: true,
          data: {
            name: active,
            channelId: profile?.channelId,
            channelTitle: profile?.channelTitle,
            addedAt: profile?.addedAt ? new Date(profile.addedAt).toISOString() : undefined,
            hasTokens: !!profile?.tokens,
          },
        });
      } catch (err) {
        return toolResult(buildErrorResponse(toMcpError(err), getQuotaSummary(0)));
      }
    }
  );

  server.registerTool(
    "youtube_account_remove",
    {
      description: "Disconnect and remove a channel profile. Requires confirm: true. Cannot remove the last profile.",
      inputSchema: RemoveChannelSchema,
    },
    async (params) => {
      try {
        const profiles = tokenStore.listProfiles();
        if (profiles.length <= 1) {
          throw new YouTubeMcpError(
            YouTubeMcpErrorCode.INTERNAL_ERROR,
            "Cannot remove the only connected channel. Add another channel first."
          );
        }
        const profile = tokenStore.getProfile(params.name);
        if (!profile) {
          throw new YouTubeMcpError(YouTubeMcpErrorCode.INTERNAL_ERROR, `Profile "${params.name}" not found.`);
        }
        tokenStore.removeProfile(params.name);
        resetAllAuthClients();
        const newActive = tokenStore.getActiveProfileName();
        return toolResult({
          success: true,
          data: {
            removed: params.name,
            activeProfile: newActive,
            message: `Profile "${params.name}" removed. Active profile is now "${newActive}".`,
          },
        });
      } catch (err) {
        return toolResult(buildErrorResponse(toMcpError(err), getQuotaSummary(0)));
      }
    }
  );
}
