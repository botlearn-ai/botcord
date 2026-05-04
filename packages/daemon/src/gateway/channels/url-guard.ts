/**
 * W9: SSRF guard for user-supplied `baseUrl` values that flow into
 * authenticated daemon-side fetches (Telegram getMe, WeChat iLink).
 *
 * Policy: scheme MUST be `https`; the hostname MUST match one of the
 * explicitly-allowed well-known API hosts (case-insensitive exact match).
 * Switching from blocklist to allowlist closes the GCP/AWS metadata hostname
 * pivot vector — blocklists miss names like `metadata.google.internal`,
 * `*.svc.cluster.local`, etc.
 *
 * The test host `botcord-test.local` is added only when
 * NODE_ENV === "test" to keep unit tests working without relaxing production
 * policy.
 */

export class UnsafeBaseUrlError extends Error {
  constructor(reason: string) {
    super(`unsafe_base_url: ${reason}`);
    this.name = "UnsafeBaseUrlError";
  }
}

function allowedHosts(): Set<string> {
  const hosts = new Set(["api.telegram.org", "ilinkai.weixin.qq.com"]);
  if (process.env.NODE_ENV === "test") {
    hosts.add("botcord-test.local");
  }
  return hosts;
}

export function assertSafeBaseUrl(value: string | undefined | null): void {
  if (value === undefined || value === null || value === "") {
    // Caller handles the "no baseUrl supplied → use default" path.
    return;
  }
  if (typeof value !== "string") {
    throw new UnsafeBaseUrlError("not a string");
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new UnsafeBaseUrlError("not a valid URL");
  }
  if (parsed.protocol !== "https:") {
    throw new UnsafeBaseUrlError(`scheme "${parsed.protocol}" is not https`);
  }
  const host = parsed.hostname.toLowerCase();
  if (!host) {
    throw new UnsafeBaseUrlError("empty host");
  }
  if (!allowedHosts().has(host)) {
    throw new UnsafeBaseUrlError(`host "${host}" is not in the allowlist`);
  }
}
