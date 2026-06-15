const SAFE_ERROR_NAME_RE = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const SAFE_ERRNO_CODE_RE = /^[A-Z0-9_]{1,64}$/;
const SAFE_SUMMARY_RE = /^[A-Za-z][A-Za-z0-9_.-]{0,63}: [a-z][a-z0-9_]{0,63}$/;
const MAX_SUMMARY_LENGTH = 96;

export interface SafeObservableErrorMeta extends Record<string, unknown> {
  name: string;
  message: string;
  cause?: {
    code?: string;
    errno?: string | number;
  };
}

export function safeObservableErrorMeta(err: unknown): SafeObservableErrorMeta {
  const error = err as { name?: unknown; message?: unknown; cause?: unknown };
  const rawMessage = typeof error?.message === "string" ? error.message : String(err);
  const meta: SafeObservableErrorMeta = {
    name: safeErrorName(error?.name),
    message: errorMessageCategory(rawMessage),
  };

  const cause = error?.cause as { code?: unknown; errno?: unknown } | undefined;
  const code = safeCauseCode(cause?.code);
  const errno = safeCauseErrno(cause?.errno);
  if (code !== undefined || errno !== undefined) {
    meta.cause = {
      ...(code !== undefined ? { code } : {}),
      ...(errno !== undefined ? { errno } : {}),
    };
  }
  return meta;
}

export function safeObservableErrorSummary(err: unknown): string {
  const meta = safeObservableErrorMeta(err);
  return `${meta.name}: ${meta.message}`.slice(0, MAX_SUMMARY_LENGTH);
}

export function safeObservableStatusError(value: string | null | undefined): string | null | undefined {
  if (value === null || value === undefined) return value;
  if (SAFE_SUMMARY_RE.test(value)) return value;
  return safeObservableErrorSummary(new Error(value));
}

function safeErrorName(value: unknown): string {
  if (typeof value !== "string") return "Error";
  return SAFE_ERROR_NAME_RE.test(value) ? value : "Error";
}

function safeCauseCode(value: unknown): string | undefined {
  return typeof value === "string" && SAFE_ERRNO_CODE_RE.test(value) ? value : undefined;
}

function safeCauseErrno(value: unknown): string | number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return safeCauseCode(value);
}

function errorMessageCategory(message: string): string {
  const lower = message.toLowerCase();
  if (lower.includes("fetch failed")) return "fetch_failed";
  if (lower.includes("getupdates failed")) return "getupdates_failed";
  if (lower.includes("sendmessage failed")) return "sendmessage_failed";
  if (lower.includes("missing_secret") || lower.includes("bot token not loaded")) {
    return "missing_secret";
  }
  if (lower.includes("unauthorized") || lower.includes("401")) return "unauthorized";
  if (lower.includes("forbidden") || lower.includes("403")) return "forbidden";
  if (lower.includes("too many requests") || lower.includes("rate limit") || lower.includes("429")) {
    return "rate_limited";
  }
  if (lower.includes("timeout") || lower.includes("timed out")) return "timeout";
  if (lower.includes("abort")) return "aborted";
  if (lower.includes("network")) return "network_error";
  return "error";
}
