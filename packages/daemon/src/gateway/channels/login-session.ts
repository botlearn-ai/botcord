/**
 * In-memory login-session store used by the daemon's third-party gateway
 * control frames. Today only WeChat consumes it (qrcode → bot token), but
 * the shape is provider-generic so future LINE/Discord OAuth callbacks can
 * reuse the same store without a control-frame churn.
 *
 * The store is intentionally NOT persisted — bot tokens never live anywhere
 * outside the daemon process or the per-gateway secret file. A daemon
 * restart drops in-flight logins; the user just rescans.
 */

export type LoginProvider = "wechat" | "telegram";

export interface LoginSession {
  loginId: string;
  accountId: string;
  gatewayId?: string;
  provider: LoginProvider;
  /** WeChat: opaque qrcode string returned by `get_bot_qrcode`. */
  qrcode?: string;
  /** Optional renderable URL for the qrcode. */
  qrcodeUrl?: string;
  /** WeChat iLink base URL the bot token will be used against. */
  baseUrl?: string;
  /** Stored only after the user confirms the qrcode. Never returned to Hub. */
  botToken?: string;
  /** Masked preview safe for Hub/dashboard display. */
  tokenPreview?: string;
  /** Unix millis. */
  expiresAt: number;
}

/** Default session TTL: 5 minutes per the design doc. */
export const LOGIN_SESSION_TTL_MS = 5 * 60 * 1000;

export interface LoginSessionStoreOptions {
  /** Override the wall clock — used by tests. */
  now?: () => number;
  /** Override the TTL applied at `create` time. */
  ttlMs?: number;
}

/**
 * Lazy-evicting login session map. Eviction runs inline on every read/write
 * so no background timer is required and tests can scrub state by advancing
 * a fake clock.
 */
export class LoginSessionStore {
  private readonly sessions = new Map<string, LoginSession>();
  private readonly now: () => number;
  private readonly ttlMs: number;

  constructor(opts: LoginSessionStoreOptions = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.ttlMs = opts.ttlMs ?? LOGIN_SESSION_TTL_MS;
  }

  /**
   * Insert a fresh session. `expiresAt` is computed as `now() + ttlMs`
   * unless the caller pre-populated it. Returns the persisted record.
   */
  create(input: Omit<LoginSession, "expiresAt"> & { expiresAt?: number }): LoginSession {
    this.sweep();
    const expiresAt = typeof input.expiresAt === "number" ? input.expiresAt : this.now() + this.ttlMs;
    const session: LoginSession = { ...input, expiresAt };
    this.sessions.set(session.loginId, session);
    return session;
  }

  /** Get a non-expired session by id, or `null` when missing/expired. */
  get(loginId: string): LoginSession | null {
    this.sweep();
    return this.sessions.get(loginId) ?? null;
  }

  /**
   * Apply a partial patch to the session in place. No-op when the session
   * is missing or expired. Returns the updated record (or `null`).
   */
  update(loginId: string, patch: Partial<LoginSession>): LoginSession | null {
    const cur = this.get(loginId);
    if (!cur) return null;
    const next = { ...cur, ...patch };
    this.sessions.set(loginId, next);
    return next;
  }

  delete(loginId: string): boolean {
    return this.sessions.delete(loginId);
  }

  /** Drop every entry whose `expiresAt` is in the past. */
  sweep(): void {
    const t = this.now();
    for (const [id, s] of this.sessions) {
      if (s.expiresAt <= t) this.sessions.delete(id);
    }
  }

  /** Test helper: number of live sessions after sweep. */
  size(): number {
    this.sweep();
    return this.sessions.size;
  }
}

/**
 * Build a masked preview suitable for dashboard display. Returns the raw
 * value untouched when shorter than 8 chars (no point masking) or `""` when
 * empty. Default format: `"abcd...wxyz"` with a single ellipsis, never
 * leaking the middle of the secret.
 */
export function maskTokenPreview(token: string | undefined | null): string {
  if (!token) return "";
  if (token.length <= 8) return token;
  return `${token.slice(0, 4)}...${token.slice(-4)}`;
}

/**
 * Allocate a new login id. Format `wxl_<base36ts>_<rand>` so it sorts by
 * creation time and is trivially distinguishable from BotCord agent ids.
 */
export function mintLoginId(provider: LoginProvider): string {
  const prefix = provider === "wechat" ? "wxl" : "tgl";
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${ts}_${rand}`;
}
