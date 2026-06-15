/**
 * Runtime CLIs sometimes report authentication failures as ordinary final
 * text. Keep this intentionally narrow so normal model replies about auth do
 * not get reclassified unless they look like a top-level CLI/API failure.
 */
export function looksLikeRuntimeAuthFailure(text: string): boolean {
  const s = text.trim();
  if (!s) return false;
  return (
    /^(Failed to authenticate|Authentication failed|Invalid API key|Invalid Anthropic API key)\b/i.test(s) ||
    /^API Error:\s*4\d\d\b/i.test(s) ||
    /\b(API Error:\s*4\d\d|Request not allowed|invalid x-api-key)\b/i.test(s) ||
    /^(Unauthorized|Forbidden)(?:\b|:)/i.test(s)
  );
}

/**
 * Transient (worth-one-retry) runtime failures: connection blips, 5xx-class
 * gateway errors, and JSON-RPC internal errors (ACP code -32603, e.g. hermes
 * raising an internal error mid-prompt). Intentionally narrow — a non-zero exit
 * code, bad config, or unknown CLI option is permanent and must NOT match, or
 * the dispatcher would loop on it. The caller additionally gates retries on
 * "no output was produced yet" so retrying cannot duplicate side effects.
 */
const TRANSIENT_RUNTIME_ERROR_PATTERNS: RegExp[] = [
  /\b(?:ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|EPIPE)\b/i,
  /\bsocket hang ?up\b/i,
  /\bconnection (?:refused|reset|closed|timed out)\b/i,
  /\b-32603\b/,
  /\binternal error\b/i,
  /\b(?:bad gateway|service unavailable|gateway timeout|temporarily unavailable)\b/i,
  /\b50[0234]\b/,
];

export function looksLikeTransientRuntimeError(text: string): boolean {
  const s = text?.trim();
  if (!s) return false;
  return TRANSIENT_RUNTIME_ERROR_PATTERNS.some((re) => re.test(s));
}

/**
 * Usage / rate-limit exhaustion is reported by runtimes as ordinary error text,
 * not a distinct status. Claude Code emits "Claude usage limit reached. Your
 * limit will reset at 2pm (America/New_York)"; Codex emits "You've reached your
 * 5-hour message limit. Try again in 3h 42m." or a bare
 * `{"type":"error","error":{"type":"usage_limit_reached",...}}` blob. Detect it
 * so the dispatcher can surface a calm, reset-time-forward sentence instead of a
 * red "Runtime error" wrapped in an exit code and an error_ref.
 */
const USAGE_LIMIT_PATTERNS: RegExp[] = [
  /usage[_\s-]?limit[_\s-]?reached/i,
  /\b\d+-hour (?:message )?limit\b/i,
  /you'?ve (?:hit|reached) your (?:usage |message |daily |weekly )*limit/i,
  /\binsufficient_quota\b/i,
  /\bquota (?:exceeded|exhausted|reached)\b/i,
  /\brate[_\s-]?limit(?:_?(?:exceeded|error)|ed|\s+(?:reached|exceeded|hit))/i,
];

export function looksLikeUsageLimit(text: string): boolean {
  const s = text?.trim();
  if (!s) return false;
  return USAGE_LIMIT_PATTERNS.some((re) => re.test(s));
}

/**
 * Pull the reset hint straight out of the runtime's own words — never compute it
 * locally, since the runtime already knows the user's plan window and timezone
 * and we do not. Returns a ready-to-render fragment: an absolute clock time like
 * "2pm (America/New_York)", a relative "in 3h 42m", or null when the runtime
 * gave no hint.
 */
export function extractUsageLimitReset(text: string): string | null {
  const s = (text ?? "").trim();
  if (!s) return null;
  // Absolute: "...reset at 2pm (America/New_York)" /
  //           "reset at approximately 11:00 PM Europe/Berlin time"
  const at = s.match(/reset(?:s|ting)?\s+at\s+(?:approximately\s+)?(.+?)(?:\s+time\b)?\s*(?:[.,\n]|$)/i);
  if (at?.[1]) return collapseWs(at[1]);
  // Relative: "Try again in 3h 42m" / "please try again after 5 minutes"
  const rel = s.match(/try again (?:in|after)\s+(.+?)\s*(?:[.,\n]|$)/i);
  if (rel?.[1]) return `in ${collapseWs(rel[1])}`;
  // Legacy Claude headless pipe form: "...reached|1719345600"
  const pipe = s.match(/reached\s*\|\s*(\d{10,13})/);
  if (pipe?.[1]) {
    const ms = pipe[1].length >= 13 ? Number(pipe[1]) : Number(pipe[1]) * 1000;
    if (Number.isFinite(ms)) return `${new Date(ms).toISOString().replace("T", " ").slice(0, 16)} UTC`;
  }
  return null;
}

/**
 * Compose the calm, user-facing line for a usage/rate-limit error. Callers
 * should gate on {@link looksLikeUsageLimit} first.
 */
export function formatUsageLimitMessage(text: string, runtime?: string): string {
  const who = runtimeLabel(runtime);
  const reset = extractUsageLimitReset(text);
  if (reset) {
    const when = /^in\s/i.test(reset) ? `resets ${reset}` : `resets at ${reset}`;
    return `${who} usage limit reached — ${when}.`;
  }
  return `${who} usage limit reached — please try again later.`;
}

function runtimeLabel(runtime?: string): string {
  switch ((runtime ?? "").toLowerCase()) {
    case "claude-code":
    case "claude":
      return "Claude Code";
    case "codex":
      return "Codex";
    case "gemini":
      return "Gemini";
    default:
      return "Agent runtime";
  }
}

function collapseWs(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}
