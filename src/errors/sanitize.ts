/**
 * Remove anything that looks like a credential from text that is logged or returned to the
 * AI client (library errors can echo URLs, headers or token fragments).
 */
const PATTERNS: Array<[RegExp, string]> = [
  [/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [redacted]"],
  [/ya29\.[A-Za-z0-9._-]+/g, "[redacted-google-token]"],
  [/1\/\/[A-Za-z0-9._-]{20,}/g, "[redacted-google-refresh-token]"],
  [/\bv1\.[A-Za-z0-9_-]{40,}/g, "[redacted-token]"],
  [/(client_secret|refresh_token|access_token|code_verifier|id_token)=([^&\s"']+)/gi, "$1=[redacted]"],
  [/("(?:client_secret|refresh_token|access_token|id_token)"\s*:\s*")[^"]+(")/gi, "$1[redacted]$2"],
];

export function sanitizeMessage(message: string, maxLength = 600): string {
  let out = message;
  for (const [re, repl] of PATTERNS) out = out.replace(re, repl);
  return out.length > maxLength ? `${out.slice(0, maxLength)}…` : out;
}
