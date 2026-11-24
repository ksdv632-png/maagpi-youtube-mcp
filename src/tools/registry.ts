import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerVideoTools } from "./videos.js";
import { registerPublishingTools } from "./publishing.js";
import { registerAnalyticsTools } from "./analytics.js";
import { registerCommentTools } from "./comments.js";
import { registerPlaylistTools } from "./playlists.js";
import { registerChannelTools } from "./channels.js";
import { registerAccountTools } from "./account.js";
import { TOOL_ANNOTATIONS } from "./annotations.js";

/**
 * Deliberately NOT registered anywhere: video deletion. The server cannot delete videos —
 * not even by mistake or through a prompt-injected instruction.
 *
 * Other destructive tools (playlist/comment/section deletion) exist only when the owner opts in
 * with YOUTUBE_MCP_ALLOW_DESTRUCTIVE=true (config.allowDestructive).
 */
/** Adds the annotations from TOOL_ANNOTATIONS to every registerTool() call made through the returned server. */
function withAnnotations(server: McpServer): McpServer {
  return new Proxy(server, {
    get(target, prop) {
      if (prop === "registerTool") {
        return (name: string, toolConfig: Record<string, unknown>, cb: never) =>
          (target.registerTool as (n: string, c: Record<string, unknown>, h: never) => unknown)(
            name,
            { annotations: TOOL_ANNOTATIONS[name], ...toolConfig },
            cb
          );
      }
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}

export function registerAllTools(rawServer: McpServer): void {
  const server = withAnnotations(rawServer);
  registerVideoTools(server);
  registerPublishingTools(server);
  registerAnalyticsTools(server);
  registerCommentTools(server);
  registerPlaylistTools(server);
  registerChannelTools(server);
  registerAccountTools(server);
}
