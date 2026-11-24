import "dotenv/config";
import { createServer } from "./server.js";
import { startTransport } from "./transport/index.js";
import { logger } from "./logger.js";

process.on("unhandledRejection", (reason) => {
  // Keep serving: a stray rejection must not kill uploads that are running for other requests.
  logger.error("Unhandled promise rejection", {
    reason: reason instanceof Error ? reason.name : typeof reason,
  });
});

await startTransport(createServer);
