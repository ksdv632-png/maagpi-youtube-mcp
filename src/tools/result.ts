export interface ToolTextResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

/** Wrap a JSON-serialisable payload as an MCP tool result; `success: false` payloads set isError. */
export function toolResult(data: unknown): ToolTextResult {
  const isError =
    typeof data === "object" && data !== null && (data as { success?: unknown }).success === false;
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}
