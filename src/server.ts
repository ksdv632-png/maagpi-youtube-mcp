import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { config, isRemote } from "./config.js";
import { registerAllTools } from "./tools/registry.js";

const PKG_NAME = "maagpi-youtube-mcp";
const PKG_VERSION = "1.1.0";

/** Shown to the AI client when it connects. Short, rule-first. */
export function buildInstructions(): string {
  const lines = [
    "You manage the user's own YouTube channel through the official YouTube Data/Analytics APIs.",
    "",
    "RULES",
    "1. Never publish on your own. Uploads are always PRIVATE. Making a video public/unlisted or scheduling it needs the owner's approval: " +
      (isRemote
        ? "youtube_video_set_privacy / youtube_video_schedule_publish first return status 'approval_required' with a link. Show the link to the user, wait until they say they approved, then call the same tool again with approvalId."
        : "pass confirmPublish: true only after the user explicitly said yes."),
    "2. This server cannot delete videos. Do not offer to.",
    "3. Before posting a comment reply, show the exact text to the user and wait for their OK.",
    "4. Uploads run in the background: call youtube_upload_status with the jobId until status is 'done' or 'failed'.",
    `5. The user's default time zone is ${config.displayTimeZone}. Always send publishAt as ISO 8601 with an explicit UTC offset; ask if the time zone is unclear.`,
    "6. The YouTube API cannot: change the channel name/handle/avatar, create Premieres, pin or heart comments, set playlist covers, or edit end screens/cards. Say so instead of trying.",
    "7. Videos come from cloud-storage links (Google Drive/Dropbox 'Anyone with the link' or direct https links). Ask the user for a link if they have none.",
  ];
  return lines.join("\n");
}

export function createServer(): McpServer {
  const server = new McpServer(
    { name: PKG_NAME, version: PKG_VERSION },
    { instructions: buildInstructions() }
  );
  registerAllTools(server);
  return server;
}
