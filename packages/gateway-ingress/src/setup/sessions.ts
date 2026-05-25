/**
 * In-memory setup session store for the cloud gateway ingress.
 *
 * Shape mirrors the daemon-side `LoginSession` / `LoginSessionStore` in
 * `packages/daemon/src/gateway/channels/login-session.ts` but lives in
 * the ingress namespace because cloud-agent third-party setup must be
 * owned by the always-on ingress, not by a (pauseable) cloud daemon.
 * See `docs/cloud-gateway-ingress-remediation-plan.md` §4.2 / §6.2.
 *
 * A setup session holds two payload kinds:
 *
 *   - `publicPayload` — qrcodeUrl, qrcode text, appId preview, etc.
 *     These are safe to return to the dashboard via the setup HTTP API.
 *   - `secretPayload` — botToken / appSecret / temporary tokens. NEVER
 *     returned by any GET/Resolve call to the HTTP layer; the only
 *     reader is the provider setup adapter's `finalize` step.
 *
 * MVP is in-memory; the interface intentionally does not bake the
 * memory implementation into its name (`IngressSetupSessionStore`) so a
 * future durable backend (short-TTL Postgres table or Redis) can drop in
 * unchanged.
 */

import { randomBytes } from "node:crypto";

import type { RuntimeGatewayProvider } from "@botcord/protocol-core";

/** Default session TTL: 5 minutes. */
export const SETUP_SESSION_TTL_MS = 5 * 60 * 1000;

export type SetupSessionStatus =
  | "pending"
  | "scanned"
  | "confirmed"
  | "expired"
  | "failed";

export interface SetupSessionPublicPayload {
  /** WeChat: opaque qrcode string returned by `get_bot_qrcode`. */
  qrcode?: string;
  /** Renderable URL for the qrcode (any provider). */
  qrcodeUrl?: string;
  /** Feishu: verification URL the user opens in the browser. */
  verificationUrl?: string;
  /** Feishu: appId preview safe for dashboard display. */
  appIdPreview?: string;
  /** Masked token preview safe for Hub/dashboard display. */
  tokenPreview?: string;
}

export interface SetupSessionSecretPayload {
  /** WeChat iLink bot token, set after qrcode confirmation. */
  botToken?: string;
  /** WeChat iLink base URL the bot token will be used against. */
  baseUrl?: string;
  /** Feishu/Lark PersonalAgent app id returned by registration. */
  appId?: string;
  /** Feishu/Lark PersonalAgent app secret returned by registration. */
  appSecret?: string;
  /** Feishu/Lark tenant domain selected during registration. */
  domain?: "feishu" | "lark";
  /** Feishu/Lark user open_id returned by registration. */
  userOpenId?: string;
  /** Telegram bot token submitted by the user / validated against getMe. */
  telegramBotToken?: string;
}

export interface SetupSession {
  loginId: string;
  agentId: string;
  userId?: string;
  provider: RuntimeGatewayProvider;
  status: SetupSessionStatus;
  publicPayload: SetupSessionPublicPayload;
  /**
   * Internal-only secret container. Never returned to the HTTP layer.
   * Provider setup adapters read this in `finalize` and write into the
   * long-term secret store keyed by gateway id.
   */
  secretPayload: SetupSessionSecretPayload;
  createdAt: number;
  updatedAt: number;
  /** Unix millis. */
  expiresAt: number;
}

export interface SetupSessionResolve {
  state: "live" | "expired" | "missing";
  session?: SetupSession;
}

export interface IngressSetupSessionStore {
  /** Insert a fresh session. `expiresAt` defaults to `now() + ttlMs`. */
  create(
    input: Omit<SetupSession, "expiresAt" | "createdAt" | "updatedAt" | "publicPayload" | "secretPayload" | "status"> & {
      expiresAt?: number;
      status?: SetupSessionStatus;
      publicPayload?: SetupSessionPublicPayload;
      secretPayload?: SetupSessionSecretPayload;
    },
  ): SetupSession;
  /**
   * Distinguish unknown loginIds ("missing") from known-but-past-TTL
   * ones ("expired"). When the entry is expired it is evicted in place
   * so callers do not need a follow-up delete.
   */
  resolve(loginId: string): SetupSessionResolve;
  /** Get a live session by id, or `null` when missing/expired. */
  get(loginId: string): SetupSession | null;
  /** Apply a partial patch. No-op when the session is missing/expired. */
  update(loginId: string, patch: SetupSessionPatch): SetupSession | null;
  /** Drop a session (e.g. after finalize). Returns true if removed. */
  delete(loginId: string): boolean;
  /** Test helper: number of live sessions after sweep. */
  size(): number;
}

export interface SetupSessionPatch {
  status?: SetupSessionStatus;
  publicPayload?: Partial<SetupSessionPublicPayload>;
  secretPayload?: Partial<SetupSessionSecretPayload>;
  expiresAt?: number;
}

export interface SetupSessionStoreOptions {
  /** Override the wall clock — used by tests. */
  now?: () => number;
  /** Override the TTL applied at `create` time. */
  ttlMs?: number;
}

/**
 * Lazy-evicting in-memory implementation. Eviction runs inline on every
 * read/write so no background timer is required and tests can scrub
 * state by advancing a fake clock.
 */
export class InMemorySetupSessionStore implements IngressSetupSessionStore {
  private readonly sessions = new Map<string, SetupSession>();
  private readonly now: () => number;
  private readonly ttlMs: number;

  constructor(opts: SetupSessionStoreOptions = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.ttlMs = opts.ttlMs ?? SETUP_SESSION_TTL_MS;
  }

  create(
    input: Omit<SetupSession, "expiresAt" | "createdAt" | "updatedAt" | "publicPayload" | "secretPayload" | "status"> & {
      expiresAt?: number;
      status?: SetupSessionStatus;
      publicPayload?: SetupSessionPublicPayload;
      secretPayload?: SetupSessionSecretPayload;
    },
  ): SetupSession {
    this.sweep();
    const t = this.now();
    const session: SetupSession = {
      loginId: input.loginId,
      agentId: input.agentId,
      ...(input.userId ? { userId: input.userId } : {}),
      provider: input.provider,
      status: input.status ?? "pending",
      publicPayload: { ...(input.publicPayload ?? {}) },
      secretPayload: { ...(input.secretPayload ?? {}) },
      createdAt: t,
      updatedAt: t,
      expiresAt: typeof input.expiresAt === "number" ? input.expiresAt : t + this.ttlMs,
    };
    this.sessions.set(session.loginId, session);
    return session;
  }

  resolve(loginId: string): SetupSessionResolve {
    const s = this.sessions.get(loginId);
    if (!s) return { state: "missing" };
    if (s.expiresAt <= this.now()) {
      this.sessions.delete(loginId);
      return { state: "expired" };
    }
    return { state: "live", session: s };
  }

  get(loginId: string): SetupSession | null {
    const { state, session } = this.resolve(loginId);
    return state === "live" && session ? session : null;
  }

  update(loginId: string, patch: SetupSessionPatch): SetupSession | null {
    const cur = this.get(loginId);
    if (!cur) return null;
    const next: SetupSession = {
      ...cur,
      ...(patch.status ? { status: patch.status } : {}),
      ...(typeof patch.expiresAt === "number" ? { expiresAt: patch.expiresAt } : {}),
      publicPayload: { ...cur.publicPayload, ...(patch.publicPayload ?? {}) },
      secretPayload: { ...cur.secretPayload, ...(patch.secretPayload ?? {}) },
      updatedAt: this.now(),
    };
    this.sessions.set(loginId, next);
    return next;
  }

  delete(loginId: string): boolean {
    return this.sessions.delete(loginId);
  }

  sweep(): void {
    const t = this.now();
    for (const [id, s] of this.sessions) {
      if (s.expiresAt <= t) this.sessions.delete(id);
    }
  }

  size(): number {
    this.sweep();
    return this.sessions.size;
  }
}

/**
 * Build a masked preview suitable for dashboard display. Returns the
 * raw value untouched when shorter than 8 chars (no point masking) or
 * "" when empty.
 */
export function maskTokenPreview(token: string | undefined | null): string {
  if (!token) return "";
  if (token.length <= 8) return token;
  return `${token.slice(0, 4)}...${token.slice(-4)}`;
}

/**
 * Allocate a new login id. Format `{prefix}_{base36ts}_{rand}` so it
 * sorts by creation time and is trivially distinguishable from BotCord
 * agent ids. Tail uses `crypto.randomBytes` (128 bits) so an attacker
 * cannot predict in-flight login ids.
 */
export function mintLoginId(provider: RuntimeGatewayProvider): string {
  const prefix = provider === "wechat" ? "wxl" : provider === "feishu" ? "fsl" : "tgl";
  const ts = Date.now().toString(36);
  const rand = randomBytes(16).toString("hex");
  return `${prefix}_${ts}_${rand}`;
}

/**
 * Allocate an opaque gateway connection id. The setup `finalize` step
 * uses this as both the connection.id and the secretRef key (per
 * remediation plan §6.1: secret ref must equal connection id).
 */
export function mintGatewayId(provider: RuntimeGatewayProvider): string {
  const prefix = provider === "wechat" ? "gw_wc" : provider === "feishu" ? "gw_fs" : "gw_tg";
  const ts = Date.now().toString(36);
  const rand = randomBytes(8).toString("hex");
  return `${prefix}_${ts}_${rand}`;
}
