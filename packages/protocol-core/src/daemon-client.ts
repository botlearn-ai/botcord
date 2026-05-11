/**
 * Minimal client for the daemon control plane (§6, §9 of the control-plane
 * plan). Wraps `/daemon/auth/*` endpoints so daemon code doesn't have to
 * hand-roll fetch calls. Supported bootstraps are the interactive device-code
 * flow (`POST /daemon/auth/device-code` + `POST /daemon/auth/device-token`)
 * and the dashboard-issued one-time install token flow.
 */
import { normalizeAndValidateHubUrl } from "./hub-url.js";

/** Shape of the JSON document returned by token-issuing endpoints. */
export interface DaemonTokenResponse {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  userId: string;
  daemonInstanceId: string;
  hubUrl: string;
}

function parseTokenResponse(raw: unknown, fallbackHubUrl: string): DaemonTokenResponse {
  const obj = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const pick = (camel: string, snake: string): unknown => obj[camel] ?? obj[snake];
  const accessToken = pick("accessToken", "access_token");
  const refreshToken = pick("refreshToken", "refresh_token");
  const expiresIn = pick("expiresIn", "expires_in");
  const userId = pick("userId", "user_id");
  const daemonInstanceId = pick("daemonInstanceId", "daemon_instance_id");
  const hubUrl = pick("hubUrl", "hub_url");
  if (typeof accessToken !== "string" || !accessToken) {
    throw new Error("daemon auth response missing accessToken");
  }
  if (typeof refreshToken !== "string" || !refreshToken) {
    throw new Error("daemon auth response missing refreshToken");
  }
  if (typeof userId !== "string" || !userId) {
    throw new Error("daemon auth response missing userId");
  }
  if (typeof daemonInstanceId !== "string" || !daemonInstanceId) {
    throw new Error("daemon auth response missing daemonInstanceId");
  }
  const expiresInNum = typeof expiresIn === "number" && expiresIn > 0 ? expiresIn : 3600;
  return {
    accessToken,
    refreshToken,
    expiresIn: expiresInNum,
    userId,
    daemonInstanceId,
    hubUrl: typeof hubUrl === "string" && hubUrl.length > 0 ? hubUrl : fallbackHubUrl,
  };
}

/**
 * Trade a `refresh_token` for a fresh access token. Called transparently
 * whenever the access token's `expiresAt` is near.
 */
export async function refreshDaemonToken(
  hubUrl: string,
  refreshToken: string,
  opts?: { timeoutMs?: number },
): Promise<DaemonTokenResponse> {
  const base = normalizeAndValidateHubUrl(hubUrl);
  const resp = await fetch(`${base}/daemon/auth/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: refreshToken }),
    signal: AbortSignal.timeout(opts?.timeoutMs ?? 10_000),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    const err = new Error(`daemon auth refresh failed: ${resp.status} ${text}`);
    (err as unknown as { status?: number }).status = resp.status;
    throw err;
  }
  return parseTokenResponse(await resp.json(), base);
}

/**
 * Redeem a dashboard-issued one-time install token for daemon user-auth.
 * The token is consumed by the Hub and cannot be reused.
 */
export async function redeemDaemonInstallToken(
  hubUrl: string,
  installToken: string,
  opts?: { label?: string; daemonInstanceId?: string; timeoutMs?: number },
): Promise<DaemonTokenResponse> {
  const base = normalizeAndValidateHubUrl(hubUrl);
  const body: Record<string, unknown> = { install_token: installToken };
  if (opts?.label) body.label = opts.label;
  if (opts?.daemonInstanceId) body.daemon_instance_id = opts.daemonInstanceId;
  const resp = await fetch(`${base}/daemon/auth/install-token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(opts?.timeoutMs ?? 10_000),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    const err = new Error(`daemon install-token redeem failed: ${resp.status} ${text}`);
    (err as unknown as { status?: number }).status = resp.status;
    throw err;
  }
  return parseTokenResponse(await resp.json(), base);
}

/**
 * Build a WebSocket URL for the daemon control channel. Translates the
 * HTTP Hub base URL to the matching `ws://` / `wss://` scheme.
 *
 * Optional `query` adds URL-encoded query parameters (e.g. `label`) so the
 * Hub can read them at WS upgrade time without a separate handshake frame.
 */
export function buildDaemonWebSocketUrl(
  hubUrl: string,
  path: string = "/daemon/ws",
  query?: Record<string, string | undefined>,
): string {
  const base = normalizeAndValidateHubUrl(hubUrl);
  const wsBase = base.replace(/^http(s?):\/\//, (_m, s: string) => `ws${s}://`);
  let qs = "";
  if (query) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (typeof v === "string" && v.length > 0) params.append(k, v);
    }
    const s = params.toString();
    if (s) qs = `?${s}`;
  }
  return `${wsBase}${path}${qs}`;
}

// ---------------------------------------------------------------------------
// Device-code login (P1.3 of the control-plane plan, §6.1)
// ---------------------------------------------------------------------------

/** Response shape for `POST /daemon/auth/device-code`. */
export interface DeviceCodeResponse {
  /** Secret — never shown to the user; stays on the daemon. */
  deviceCode: string;
  /** Short human-typeable code (e.g. `ABCD-EFGH`) shown to the user. */
  userCode: string;
  /** URL the user should visit (e.g. `https://app.botcord.dev/activate`). */
  verificationUri: string;
  /** Optional pre-filled URL (`verification_uri?user_code=ABCD-EFGH`). */
  verificationUriComplete?: string;
  /** Seconds until the device_code expires. */
  expiresIn: number;
  /** Suggested poll interval in seconds (Hub may bump this after a 429). */
  interval: number;
}

function parseDeviceCodeResponse(raw: unknown): DeviceCodeResponse {
  const obj = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const pick = (camel: string, snake: string): unknown => obj[camel] ?? obj[snake];
  const deviceCode = pick("deviceCode", "device_code");
  const userCode = pick("userCode", "user_code");
  const verificationUri = pick("verificationUri", "verification_uri");
  const verificationUriComplete =
    pick("verificationUriComplete", "verification_uri_complete") ?? undefined;
  const expiresIn = pick("expiresIn", "expires_in");
  const interval = pick("interval", "interval");
  if (typeof deviceCode !== "string" || !deviceCode) {
    throw new Error("device-code response missing deviceCode");
  }
  if (typeof userCode !== "string" || !userCode) {
    throw new Error("device-code response missing userCode");
  }
  if (typeof verificationUri !== "string" || !verificationUri) {
    throw new Error("device-code response missing verificationUri");
  }
  return {
    deviceCode,
    userCode,
    verificationUri,
    ...(typeof verificationUriComplete === "string" && verificationUriComplete.length > 0
      ? { verificationUriComplete }
      : {}),
    expiresIn: typeof expiresIn === "number" && expiresIn > 0 ? expiresIn : 600,
    interval: typeof interval === "number" && interval > 0 ? interval : 5,
  };
}

/**
 * Kick off the device-code login flow. Returns the `user_code` to display +
 * the secret `device_code` to use when polling. Plan §6.1.
 */
export async function requestDeviceCode(
  hubUrl: string,
  opts?: { label?: string; timeoutMs?: number },
): Promise<DeviceCodeResponse> {
  const base = normalizeAndValidateHubUrl(hubUrl);
  const body: Record<string, unknown> = {};
  if (opts?.label) body.label = opts.label;
  const resp = await fetch(`${base}/daemon/auth/device-code`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(opts?.timeoutMs ?? 10_000),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`daemon device-code request failed: ${resp.status} ${text}`);
  }
  return parseDeviceCodeResponse(await resp.json());
}

/** Poll result — `pending` while waiting, otherwise the issued token envelope. */
export type PollDeviceTokenResult =
  | { status: "pending" }
  | { status: "slow_down"; interval: number }
  | ({ status: "issued" } & DaemonTokenResponse);

/**
 * One poll tick against `POST /daemon/auth/device-token`. Callers are
 * expected to loop until `status: "issued"` or until the device_code
 * expires. A `slow_down` response asks the caller to back off; the new
 * recommended interval is returned.
 */
export async function pollDeviceToken(
  hubUrl: string,
  deviceCode: string,
  opts?: { label?: string; timeoutMs?: number },
): Promise<PollDeviceTokenResult> {
  const base = normalizeAndValidateHubUrl(hubUrl);
  const body: Record<string, unknown> = { device_code: deviceCode };
  if (opts?.label) body.label = opts.label;
  const resp = await fetch(`${base}/daemon/auth/device-token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(opts?.timeoutMs ?? 10_000),
  });
  // Hub idiom: 200 OK with a status-bearing JSON envelope. We also tolerate
  // OAuth-style 4xx + `error: authorization_pending|slow_down` shapes since
  // the contract may land in either form — see the §6.1 plan note.
  if (resp.status === 200) {
    const data = (await resp.json().catch(() => ({}))) as Record<string, unknown>;
    const status = (data.status ?? data.state) as unknown;
    if (status === "pending" || status === "authorization_pending") {
      return { status: "pending" };
    }
    if (status === "slow_down") {
      const i = data.interval;
      return {
        status: "slow_down",
        interval: typeof i === "number" && i > 0 ? i : 10,
      };
    }
    // Default: assume the envelope is the token response (status absent or
    // status === "issued" / "ok").
    const tok = parseTokenResponse(data, base);
    return { status: "issued", ...tok };
  }
  if (resp.status === 400 || resp.status === 428) {
    const data = (await resp.json().catch(() => ({}))) as Record<string, unknown>;
    const err = (data.error ?? data.code) as unknown;
    if (err === "authorization_pending") return { status: "pending" };
    if (err === "slow_down") {
      const i = data.interval;
      return {
        status: "slow_down",
        interval: typeof i === "number" && i > 0 ? i : 10,
      };
    }
    throw new Error(
      `daemon device-token poll failed: ${resp.status} ${typeof err === "string" ? err : JSON.stringify(data)}`,
    );
  }
  const text = await resp.text().catch(() => "");
  throw new Error(`daemon device-token poll failed: ${resp.status} ${text}`);
}

// ---------------------------------------------------------------------------
// Hub control-plane signing key
// ---------------------------------------------------------------------------

/**
 * Base64-encoded raw Ed25519 public key the Hub uses to sign control frames
 * destined for this daemon. Verified by the daemon's `control-channel.ts`
 * before any handler runs.
 *
 * This is the dev/default key baked into the Hub when
 * `BOTCORD_HUB_CONTROL_PRIVATE_KEY` is unset; production rotates via env.
 * To replace the constant, edit this file and rebuild
 * `@botcord/protocol-core`. Operators can also override at runtime via
 * `BOTCORD_HUB_CONTROL_PUBLIC_KEY`.
 */
export const HUB_CONTROL_PUBLIC_KEY = "H8lKtrtJclp+M69dh0n0avdia/kN8fy1tYUSrQFpDxY=";

/**
 * Resolve the Hub control-plane Ed25519 public key, honoring the
 * `BOTCORD_HUB_CONTROL_PUBLIC_KEY` env override when present. Returns
 * `null` when no key is configured (env override empty AND embedded
 * constant blanked) — callers treat that as "verification disabled, log a
 * warning" rather than a hard failure.
 */
export function resolveHubControlPublicKey(env?: Record<string, string | undefined>): string | null {
  const e = env ?? (typeof process !== "undefined" ? process.env : {});
  const override = e?.BOTCORD_HUB_CONTROL_PUBLIC_KEY;
  if (typeof override === "string" && override.length > 0) {
    return override;
  }
  if (HUB_CONTROL_PUBLIC_KEY && HUB_CONTROL_PUBLIC_KEY.length > 0) {
    return HUB_CONTROL_PUBLIC_KEY;
  }
  return null;
}
