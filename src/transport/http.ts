import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { createRemoteApp } from "../remote/app.js";

export async function startHttpTransport(createMcpServer: () => McpServer): Promise<void> {
  const app = createRemoteApp({ config, createMcpServer });

  const httpServer = await new Promise<import("node:http").Server>((resolve, reject) => {
    const srv = app.listen(config.httpPort, config.httpHost, () => resolve(srv));
    srv.once("error", reject);
  });
  // Keep-alive longer than the platform proxy's idle timeout, otherwise the proxy can reuse a closed socket (502).
  httpServer.keepAliveTimeout = 65_000;
  httpServer.headersTimeout = 66_000;

  logger.info(`YouTube MCP remote server listening on ${config.httpHost}:${config.httpPort}`);
  if (config.publicUrl) logger.info(`  MCP endpoint (Claude connector URL): ${config.publicUrl}/mcp`);

  const shutdown = (signal: string): void => {
    logger.info(`${signal} received, shutting down`);
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));
}
