import { YouTubeMcpErrorCode } from "./codes.js";
import { YouTubeMcpError, QuotaSummary, McpErrorResponse } from "./types.js";
import { sanitizeMessage } from "./sanitize.js";

interface GaxiosErrorLike {
  response?: {
    status?: number;
    data?: {
      error?: {
        errors?: Array<{ reason?: string; domain?: string; message?: string }>;
        message?: string;
        code?: number;
      };
    };
  };
  code?: string | number;
  message?: string;
}

function isGaxiosError(err: unknown): err is GaxiosErrorLike {
  return (
    typeof err === "object" &&
    err !== null &&
    "response" in err &&
    typeof (err as GaxiosErrorLike).response === "object"
  );
}

function mapNotFoundCode(methodName: string): YouTubeMcpErrorCode {
  if (methodName.includes("playlist_item")) return YouTubeMcpErrorCode.PLAYLIST_ITEM_NOT_FOUND;
  if (methodName.includes("playlist")) return YouTubeMcpErrorCode.PLAYLIST_NOT_FOUND;
  if (methodName.includes("comment")) return YouTubeMcpErrorCode.COMMENT_NOT_FOUND;
  if (methodName.includes("channel")) return YouTubeMcpErrorCode.CHANNEL_NOT_FOUND;
  return YouTubeMcpErrorCode.VIDEO_NOT_FOUND;
}

export function classifyError(methodName: string, err: unknown): YouTubeMcpError {
  if (err instanceof YouTubeMcpError) return err;

  if (isGaxiosError(err)) {
    const status = err.response?.status ?? 0;
    const apiErrors = err.response?.data?.error?.errors ?? [];
    const firstError = apiErrors[0];
    const reason = firstError?.reason ?? "";
    const domain = firstError?.domain ?? "";
    const apiMessage = sanitizeMessage(err.response?.data?.error?.message ?? err.message ?? "Unknown API error");

    const oauthError = (err.response?.data as { error?: unknown } | undefined)?.error;
    if (oauthError === "invalid_grant" || /invalid_grant/.test(err.message ?? "")) {
      return new YouTubeMcpError(
        YouTubeMcpErrorCode.AUTH_REFRESH_FAILED,
        "Google no longer accepts the saved sign-in (it was revoked or expired).",
        {
          retryable: false,
          suggestedFix:
            "Reconnect the connector in Claude (Settings → Connectors → disconnect and connect again). If the Google Cloud app is still in 'Testing' mode, switch it to 'In production' so sign-ins do not expire after 7 days.",
          cause: err,
        }
      );
    }

    const apiError = { status, reason, domain };

    if (status === 401) {
      return new YouTubeMcpError(
        YouTubeMcpErrorCode.AUTH_TOKEN_EXPIRED,
        "Authentication token is expired or invalid.",
        {
          retryable: false,
          suggestedFix: "Re-run the server to trigger a new OAuth flow, or delete stored tokens and authenticate again.",
          docsUrl: "https://developers.google.com/youtube/v3/guides/authentication",
          apiError,
          cause: err,
        }
      );
    }

    if (status === 403) {
      if (reason === "quotaExceeded" || reason === "dailyLimitExceeded") {
        return new YouTubeMcpError(
          YouTubeMcpErrorCode.QUOTA_EXCEEDED,
          "YouTube API daily quota has been exceeded.",
          {
            retryable: false,
            suggestedFix: "Wait for quota reset at midnight Pacific Time, or increase your quota in Google Cloud Console.",
            docsUrl: "https://developers.google.com/youtube/v3/getting-started#quota",
            apiError,
            cause: err,
          }
        );
      }
      if (reason === "insufficientPermissions") {
        return new YouTubeMcpError(
          YouTubeMcpErrorCode.AUTH_INSUFFICIENT_SCOPE,
          "Insufficient OAuth scopes for this operation.",
          {
            retryable: false,
            suggestedFix: "Delete stored tokens and re-authenticate to grant the required scopes.",
            apiError,
            cause: err,
          }
        );
      }
      return new YouTubeMcpError(
        YouTubeMcpErrorCode.PERMISSION_DENIED,
        `Permission denied: ${apiMessage}`,
        {
          retryable: false,
          suggestedFix: "Ensure you are authenticated as the channel owner for this resource.",
          apiError,
          cause: err,
        }
      );
    }

    if (status === 404) {
      const code = mapNotFoundCode(methodName);
      return new YouTubeMcpError(
        code,
        `Resource not found for method '${methodName}'.`,
        {
          retryable: false,
          suggestedFix: "Verify the resource ID is correct and belongs to the authenticated account.",
          apiError,
          cause: err,
        }
      );
    }

    if (status === 429) {
      return new YouTubeMcpError(
        YouTubeMcpErrorCode.RATE_LIMITED,
        "Rate limited by YouTube API.",
        {
          retryable: true,
          retryAfterMs: 60_000,
          suggestedFix: "Wait before retrying. The server will automatically retry with backoff.",
          apiError,
          cause: err,
        }
      );
    }

    if (status >= 500) {
      return new YouTubeMcpError(
        YouTubeMcpErrorCode.INTERNAL_ERROR,
        `YouTube API server error (${status}): ${apiMessage}`,
        {
          retryable: true,
          retryAfterMs: 5_000,
          suggestedFix: "This is a temporary YouTube API issue. Retry in a few seconds.",
          apiError,
          cause: err,
        }
      );
    }
  }

  const message = sanitizeMessage(err instanceof Error ? err.message : String(err));
  return new YouTubeMcpError(
    YouTubeMcpErrorCode.INTERNAL_ERROR,
    `Unexpected error in '${methodName}': ${message}`,
    {
      retryable: false,
      cause: err,
    }
  );
}

/** Convert anything thrown inside a tool handler into a safe, structured error. */
export function toMcpError(err: unknown): YouTubeMcpError {
  if (err instanceof YouTubeMcpError) return err;
  return new YouTubeMcpError(
    YouTubeMcpErrorCode.INTERNAL_ERROR,
    sanitizeMessage(err instanceof Error ? err.message : String(err))
  );
}

export async function wrapApiCall<T>(
  methodName: string,
  fn: () => Promise<T>
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw classifyError(methodName, err);
  }
}

export function buildErrorResponse(
  err: YouTubeMcpError,
  quota: QuotaSummary
): McpErrorResponse {
  return {
    success: false,
    error: {
      code: err.code,
      message: err.message,
      suggestedFix: err.suggestedFix,
      retryable: err.retryable,
      retryAfterMs: err.retryAfterMs,
      docsUrl: err.docsUrl,
      apiError: err.apiError,
    },
    quota,
  };
}
