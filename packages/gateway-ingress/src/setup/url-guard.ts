/**
 * SSRF guard for user-supplied `baseUrl` values that flow into
 * authenticated ingress-side fetches (Telegram getMe, WeChat iLink,
 * Feishu PersonalAgent endpoints).
 *
 * Copied from `packages/daemon/src/gateway/channels/url-guard.ts`.
 * Duplicated intentionally — the ingress is the consumer-facing
 * boundary and must not depend on daemon internals (per remediation
 * plan §1.2: cloud daemon is the executor, ingress owns provider
 * setup/secret).
 *
 * Policy: scheme MUST be `https`; the hostname MUST match one of the
 * explicitly-allowed well-known API hosts (case-insensitive exact
 * match). The test host `botcord-test.local` is added only when
 * NODE_ENV === "test" to keep unit tests working without relaxing
 * production policy.
 */

export class UnsafeBaseUrlError extends Error {
  constructor(reason: string) {
    super(`unsafe_base_url: ${reason}`);
    this.name = "UnsafeBaseUrlError";
  }
}

function allowedHosts(): Set<string> {
  const hosts = new Set([
    "api.telegram.org",
    "ilinkai.weixin.qq.com",
    "open.feishu.cn",
    "open.larksuite.com",
  ]);
  if (process.env.NODE_ENV === "test") {
    hosts.add("botcord-test.local");
  }
  return hosts;
}

export function assertSafeBaseUrl(value: string | undefined | null): void {
  if (value === undefined || value === null || value === "") {
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
