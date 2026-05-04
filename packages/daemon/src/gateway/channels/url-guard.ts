/**
 * W1: defensive SSRF guard for user-supplied `baseUrl` values that flow into
 * authenticated daemon-side fetches (Telegram getMe, WeChat iLink). The Hub
 * applies the same check on the way in (`backend/app/routers/gateways.py`),
 * but a daemon that trusts every value the control plane forwards would let
 * a compromised dashboard pivot through us into the internal network.
 *
 * Policy: scheme MUST be `https`; literal-IP hostnames pointing at private,
 * loopback, link-local, multicast, or otherwise reserved space are rejected;
 * the well-known loopback hostnames (`localhost`, `ip6-localhost`,
 * `ip6-loopback`) are also rejected. DNS is intentionally NOT resolved here
 * — it widens the TOCTOU window and the literal-IP block is what catches the
 * common SSRF payloads.
 */

const DENY_HOSTNAMES = new Set(["localhost", "ip6-localhost", "ip6-loopback"]);

export class UnsafeBaseUrlError extends Error {
  constructor(reason: string) {
    super(`unsafe_base_url: ${reason}`);
    this.name = "UnsafeBaseUrlError";
  }
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
  // Strip IPv6 brackets — `URL.hostname` keeps them on `[::1]`.
  const host = parsed.hostname.replace(/^\[/, "").replace(/\]$/, "");
  if (!host) {
    throw new UnsafeBaseUrlError("empty host");
  }
  if (DENY_HOSTNAMES.has(host.toLowerCase())) {
    throw new UnsafeBaseUrlError(`host "${host}" is loopback`);
  }
  if (isLiteralIp(host) && !isPublicIp(host)) {
    throw new UnsafeBaseUrlError(`host "${host}" is in a reserved range`);
  }
}

function isLiteralIp(host: string): boolean {
  return isIpv4(host) || isIpv6(host);
}

function isIpv4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  return m.slice(1).every((s) => Number(s) >= 0 && Number(s) <= 255);
}

function isIpv6(host: string): boolean {
  // Coarse but sufficient: URL parser already validated brackets.
  return host.includes(":");
}

/** Returns true ONLY when `host` is a literal IP that is publicly routable. */
function isPublicIp(host: string): boolean {
  if (isIpv4(host)) {
    const parts = host.split(".").map((s) => Number(s));
    const [a, b] = parts as [number, number, number, number];
    if (a === 10) return false; // 10.0.0.0/8
    if (a === 127) return false; // loopback
    if (a === 0) return false; // unspecified
    if (a === 169 && b === 254) return false; // link-local
    if (a === 172 && b >= 16 && b <= 31) return false; // 172.16.0.0/12
    if (a === 192 && b === 168) return false; // 192.168.0.0/16
    if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT
    if (a >= 224) return false; // multicast + reserved
    return true;
  }
  if (isIpv6(host)) {
    const lowered = host.toLowerCase();
    if (lowered === "::" || lowered === "::1") return false;
    if (lowered.startsWith("fe80:") || lowered.startsWith("fe80::")) return false; // link-local
    if (/^f[cd]/.test(lowered)) return false; // unique local fc00::/7
    if (lowered.startsWith("ff")) return false; // multicast
    return true;
  }
  return false;
}
