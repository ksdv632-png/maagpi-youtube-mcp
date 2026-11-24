import winston from "winston";
import { config } from "./config.js";
import { sanitizeMessage } from "./errors/sanitize.js";

const isStdio = config.transport === "stdio";

/** Never let a credential reach the logs, whatever a library puts into a message. */
const redact = winston.format((info) => {
  if (typeof info.message === "string") info.message = sanitizeMessage(info.message, 2000);
  if (typeof info["stack"] === "string") info["stack"] = sanitizeMessage(info["stack"], 4000);
  return info;
});

export const logger = winston.createLogger({
  level: config.logLevel,
  format: winston.format.combine(
    redact(),
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Stream({
      stream: process.stderr,
      silent: false,
    }),
  ],
  silent: isStdio && config.nodeEnv === "production" && config.logLevel === "info",
});

if (config.nodeEnv === "development" || config.logLevel === "debug") {
  logger.format = winston.format.combine(
    redact(),
    winston.format.colorize(),
    winston.format.simple()
  );
}
