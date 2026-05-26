/**
 * Provider setup adapter contract.
 *
 * Each third-party provider implements one of these. The setup HTTP
 * server dispatches by `provider` and request kind. Adapters own the
 * provider-specific HTTP / SDK calls that map a temporary login session
 * into a long-term `GatewayConnection` + secret store entry.
 *
 * Crucially: secret payloads (botToken, appSecret, etc.) live ONLY in
 * the setup session and the long-term secret store. They never appear
 * in the HTTP response bodies returned by this layer.
 */

import type { RuntimeGatewayProvider } from "@botcord/protocol-core";

import type { IngressLogger } from "../log.js";
import type { IngressSecretStore } from "../storage/secrets.js";
import type { IngressStore } from "../storage/store.js";
import type { GatewayConnection } from "../types.js";

import type { IngressSetupSessionStore } from "./sessions.js";

export interface SetupRequestContext {
  userId: string;
  agentId: string;
  hostingKind: "cloud" | "daemon";
  requestId?: string;
}

export interface LoginStartRequest extends SetupRequestContext {
  /** Optional provider-specific overrides (e.g. WeChat baseUrl). */
  options?: Record<string, unknown>;
}

export interface LoginStartResult {
  loginId: string;
  expiresAt: number;
  /** Provider-specific public payload (qrcode, verificationUrl, ...). */
  publicPayload: Record<string, unknown>;
}

export interface LoginStatusRequest extends SetupRequestContext {
  loginId: string;
}

export interface LoginStatusResult {
  loginId: string;
  status: "pending" | "scanned" | "confirmed" | "expired" | "failed";
  /** Provider-specific public payload (tokenPreview, appIdPreview, ...). */
  publicPayload: Record<string, unknown>;
  expiresAt: number;
}

export interface DiscoverRequest extends SetupRequestContext {
  loginId: string;
  /** Optional provider-specific filter (chat type, time range, ...). */
  options?: Record<string, unknown>;
}

export interface DiscoverResult {
  /** Sender / chat candidates for allowlist UI. Shape is provider-defined. */
  candidates: Array<Record<string, unknown>>;
}

export interface FinalizeRequest extends SetupRequestContext {
  loginId: string;
  /** Provider-specific config (label, allowedSenderIds, allowedChatIds, ...). */
  config?: Record<string, unknown>;
  label?: string;
  /**
   * Whether the new connection should be started immediately. Defaults to
   * true when omitted. Adapters must honor this in `connection.enabled`
   * and pick the right initial `status` ("disabled" when false).
   */
  enabled?: boolean;
}

export interface FinalizeResult {
  connection: GatewayConnection;
}

export interface TestRequest extends SetupRequestContext {
  gatewayId: string;
}

export interface TestResult {
  ok: boolean;
  /** Optional provider-specific diagnostic payload. Must NOT include secrets. */
  details?: Record<string, unknown>;
}

export interface RotateSecretRequest extends SetupRequestContext {
  gatewayId: string;
  /**
   * Provider-specific secret material supplied by the caller. Adapters MUST
   * validate against the live provider before mutating the secret store and
   * MUST run any duplicate-token / conflict guards expected at create time.
   */
  secret: Record<string, unknown>;
}

export interface RotateSecretResult {
  /** Adapter-managed config delta to persist alongside the stored connection
   *  (e.g. Telegram's `tokenFingerprint`). Does NOT include secrets. */
  configPatch?: Record<string, unknown>;
}

export interface SetupContext {
  sessions: IngressSetupSessionStore;
  secrets: IngressSecretStore;
  store: IngressStore;
  log: IngressLogger;
  now: () => number;
}

export interface ProviderSetupAdapter {
  readonly provider: RuntimeGatewayProvider;
  loginStart?(req: LoginStartRequest, ctx: SetupContext): Promise<LoginStartResult>;
  loginStatus?(req: LoginStatusRequest, ctx: SetupContext): Promise<LoginStatusResult>;
  discover?(req: DiscoverRequest, ctx: SetupContext): Promise<DiscoverResult>;
  /**
   * Move setup-session secret + config into the long-term secret store
   * and connection store. Returns the persisted connection row (no
   * secret fields). On success the setup session SHOULD be deleted by
   * the adapter — login ids are one-shot.
   */
  finalize(req: FinalizeRequest, ctx: SetupContext): Promise<FinalizeResult>;
  /**
   * Provider live check (e.g. WeChat: re-fetch a qrcode or getupdates).
   * MVP implementations may simply return the stored status — the
   * contract is "did this credential still work?" without leaking it.
   */
  test?(req: TestRequest, ctx: SetupContext): Promise<TestResult>;
  /**
   * Provider-specific secret rotation (e.g. Telegram bot-token swap). Adapters
   * MUST validate the new secret against the upstream provider before
   * touching the secret store, MUST detect conflicts with other active
   * connections, and MUST NOT leak the secret into responses or logs.
   */
  rotateSecret?(req: RotateSecretRequest, ctx: SetupContext): Promise<RotateSecretResult>;
}

export type ProviderSetupAdapterFactory = () => ProviderSetupAdapter;

/**
 * Setup-layer error codes (per remediation plan §8). The HTTP layer
 * maps these to status codes and a redacted `{ ok: false, error: { code,
 * message } }` body. `message` MUST NOT include provider secrets.
 */
export type SetupErrorCode =
  | "bad_request"
  | "unauthorized"
  | "not_found"
  | "login_missing"
  | "login_expired"
  | "login_unconfirmed"
  | "provider_unreachable"
  | "provider_auth_failed"
  | "gateway_conflict"
  | "internal";

export class SetupError extends Error {
  readonly code: SetupErrorCode;
  readonly status: number;
  constructor(code: SetupErrorCode, message: string, status?: number) {
    super(message);
    this.name = "SetupError";
    this.code = code;
    this.status = status ?? defaultStatusFor(code);
  }
}

function defaultStatusFor(code: SetupErrorCode): number {
  switch (code) {
    case "bad_request":
      return 400;
    case "unauthorized":
      return 401;
    case "not_found":
      return 404;
    case "login_missing":
      return 404;
    case "login_expired":
      return 409;
    case "login_unconfirmed":
      return 409;
    case "gateway_conflict":
      return 409;
    case "provider_unreachable":
      return 502;
    case "provider_auth_failed":
      return 401;
    case "internal":
    default:
      return 500;
  }
}
