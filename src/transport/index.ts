import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { config } from "../config.js";
import { startStdioTransport } from "./stdio.js";
import { startHttpTransport } from "./http.js";

/**
 * stdio: one long-lived server for the single local client.
 * http : a fresh McpServer per request (stateless Streamable HTTP), so no session state is
 *        lost when the platform restarts or redeploys the container.
 */
export async function startTransport(createMcpServer: () => McpServer): Promise<void> {
  if (config.transport === "http") {
    return startHttpTransport(createMcpServer);
  }
  return startStdioTransport(createMcpServer());
}
