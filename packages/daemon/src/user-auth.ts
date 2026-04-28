/**
 * User-identity credentials for the daemon control plane.
 *
 * Unlike agent credentials (one file per agent under
 * `~/.botcord/credentials/*.json`), the user-auth record is singular —
 * the daemon only logs in as *one* user at a time. Stored at
 * `~/.botcord/daemon/user-auth.json` with `0600` permissions.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  refreshDaemonToken,
  type DaemonTokenResponse,
} from "@botcord/protocol-core";
import { DAEMON_DIR_PATH } from "./config.js";
import { log as daemonLog } from "./log.js";

export const USER_AUTH_PATH = path.join(DAEMON_DIR_PATH, "user-auth.json");
export const AUTH_EXPIRED_FLAG_PATH = path.join(DAEMON_DIR_PATH, "auth-expired.flag");

/** Persisted user-auth shape. Versioned so future fields can be added safely. */
export interface UserAuthRecord {
  version: 1;
  userId: string;
  daemonInstanceId: string;
  hubUrl: string;
  accessToken: string;
  refreshToken: string;
  /** Absolute unix millis when the access token expires. */
  expiresAt: number;
  /** ISO timestamp of initial token issuance — informational only. */
  loggedInAt: string;
  /** Optional human label (e.g. "MacBook Pro") set at login. */
  label?: string;
}

function ensureDaemonDir(): void {
  try {
    mkdirSync(DAEMON_DIR_PATH, { recursive: true, mode: 0o700 });
  } catch {
    // best-effort
  }
}

/**
 * Refuse to load user-auth if the file is group/world readable. This is a
 * hard stop — a leaked refresh token gives an attacker permanent control
 * over the daemon. Returns `true` when permissions are acceptable; throws
 * otherwise so callers surface a clear remediation hint.
 */
function assertSecurePermissions(file: string): void {
  const st = statSync(file);
  // mode is packaged as unix bits — mask off everything except owner to
  // detect any group/world bits.
  if ((st.mode & 0o077) !== 0) {
    throw new Error(
      `daemon user-auth file ${file} has insecure permissions (mode ${(st.mode & 0o777).toString(8)}); run \`chmod 600 ${file}\``,
    );
  }
}

/**
 * Read and return the on-disk user-auth record, or `null` if no login has
 * happened yet. Throws on malformed content / insecure permissions.
 */
export function loadUserAuth(file: string = USER_AUTH_PATH): UserAuthRecord | null {
  if (!existsSync(file)) return null;
  assertSecurePermissions(file);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(
      `daemon user-auth file ${file} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`daemon user-auth file ${file} must be a JSON object`);
  }
  const obj = parsed as Record<string, unknown>;
  const str = (k: string): string => {
    const v = obj[k];
    if (typeof v !== "string" || v.length === 0) {
      throw new Error(`daemon user-auth file ${file} missing "${k}"`);
    }
    return v;
  };
  const num = (k: string): number => {
    const v = obj[k];
    if (typeof v !== "number" || !Number.isFinite(v)) {
      throw new Error(`daemon user-auth file ${file} missing numeric "${k}"`);
    }
    return v;
  };
  return {
    version: 1,
    userId: str("userId"),
    daemonInstanceId: str("daemonInstanceId"),
    hubUrl: str("hubUrl"),
    accessToken: str("accessToken"),
    refreshToken: str("refreshToken"),
    expiresAt: num("expiresAt"),
    loggedInAt: typeof obj.loggedInAt === "string" ? obj.loggedInAt : new Date().toISOString(),
    ...(typeof obj.label === "string" ? { label: obj.label } : {}),
  };
}

/** Atomically persist a user-auth record with mode 0600. */
export function saveUserAuth(
  record: UserAuthRecord,
  file: string = USER_AUTH_PATH,
): void {
  ensureDaemonDir();
  const tmp = file + ".tmp";
  writeFileSync(tmp, JSON.stringify(record, null, 2), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
  chmodSync(file, 0o600);
  daemonLog.debug("user-auth saved", {
    file,
    userId: record.userId,
    expiresAt: record.expiresAt,
  });
}

/** Remove user-auth (e.g. after a hard revoke). Safe on missing file. */
export function clearUserAuth(file: string = USER_AUTH_PATH): void {
  try {
    unlinkSync(file);
    daemonLog.info("user-auth cleared", { file });
  } catch {
    // ignore
  }
}

/**
 * Build a {@link UserAuthRecord} from a freshly issued daemon token
 * envelope. Shared helper so login and refresh stay in sync about what
 * fields the on-disk shape carries.
 */
export function userAuthFromTokenResponse(
  tok: DaemonTokenResponse,
  opts?: { label?: string; loggedInAt?: string },
): UserAuthRecord {
  return {
    version: 1,
    userId: tok.userId,
    daemonInstanceId: tok.daemonInstanceId,
    hubUrl: tok.hubUrl,
    accessToken: tok.accessToken,
    refreshToken: tok.refreshToken,
    expiresAt: Date.now() + tok.expiresIn * 1000,
    loggedInAt: opts?.loggedInAt ?? new Date().toISOString(),
    ...(opts?.label ? { label: opts.label } : {}),
  };
}

/** Write the `auth-expired.flag` stamp. Used by the control channel when a refresh 401s. */
export function writeAuthExpiredFlag(file: string = AUTH_EXPIRED_FLAG_PATH): void {
  ensureDaemonDir();
  writeFileSync(file, JSON.stringify({ expiredAt: new Date().toISOString() }), {
    mode: 0o600,
  });
  daemonLog.warn("user-auth expired flag written", { file });
}

/** Remove the auth-expired flag (e.g. after a successful re-login). */
export function clearAuthExpiredFlag(file: string = AUTH_EXPIRED_FLAG_PATH): void {
  try {
    unlinkSync(file);
    daemonLog.debug("user-auth expired flag cleared", { file });
  } catch {
    // ignore
  }
}

/** Returns true if the stored access token is within `windowMs` of expiry. */
export function isTokenNearExpiry(record: UserAuthRecord, windowMs = 60_000): boolean {
  return record.expiresAt - Date.now() <= windowMs;
}

/**
 * Thrown when the Hub rejects a refresh token (401/403). Signals that the
 * user must re-login — reconnect loops should stop instead of hammering
 * the refresh endpoint forever with a known-bad token.
 */
export class AuthRefreshRejectedError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "AuthRefreshRejectedError";
    this.status = status;
  }
}

/**
 * Stateful helper that owns the in-memory copy of user-auth and knows how
 * to refresh it. Used by the control channel so reconnects always carry
 * a fresh access token.
 */
export class UserAuthManager {
  private record: UserAuthRecord | null;
  private readonly file: string;
  private refreshInflight: Promise<UserAuthRecord> | null = null;

  constructor(opts: { record: UserAuthRecord | null; file?: string } = { record: null }) {
    this.record = opts.record;
    this.file = opts.file ?? USER_AUTH_PATH;
  }

  /** Load user-auth from disk; static convenience that wraps the ctor. */
  static load(file: string = USER_AUTH_PATH): UserAuthManager {
    return new UserAuthManager({ record: loadUserAuth(file), file });
  }

  /** The current (possibly stale) record, or `null` if not logged in. */
  get current(): UserAuthRecord | null {
    return this.record;
  }

  /**
   * Return a valid access token, refreshing transparently if near expiry.
   * Callers must treat the returned string as short-lived — re-invoke on
   * 401 responses.
   */
  async ensureAccessToken(): Promise<string> {
    if (!this.record) {
      throw new Error("daemon not logged in (no user-auth)");
    }
    if (!isTokenNearExpiry(this.record)) {
      return this.record.accessToken;
    }
    const refreshed = await this.refresh();
    return refreshed.accessToken;
  }

  /**
   * Force-refresh the access token. Deduplicates concurrent callers so
   * a single network request settles them all.
   */
  async refresh(): Promise<UserAuthRecord> {
    if (!this.record) {
      throw new Error("daemon not logged in (no user-auth)");
    }
    if (this.refreshInflight) return this.refreshInflight;
    const current = this.record;
    daemonLog.info("user-auth refresh: start", {
      userId: current.userId,
      hubUrl: current.hubUrl,
      expiresInMs: current.expiresAt - Date.now(),
    });
    this.refreshInflight = (async () => {
      // Refresh tokens rotate server-side. If another local process (e.g. a
      // second daemon racing on the same user-auth.json) refreshed in the
      // meantime, the on-disk refreshToken now differs from our in-memory
      // copy — using the in-memory one would 401 because the server already
      // invalidated it. Re-read disk first and adopt any newer record.
      let basis = current;
      try {
        const onDisk = loadUserAuth(this.file);
        if (onDisk && onDisk.refreshToken !== current.refreshToken) {
          daemonLog.info("user-auth refresh: adopting newer on-disk token", {
            userId: onDisk.userId,
            expiresAt: onDisk.expiresAt,
          });
          this.record = onDisk;
          if (!isTokenNearExpiry(onDisk)) return onDisk;
          basis = onDisk;
        }
      } catch (err) {
        daemonLog.debug("user-auth refresh: disk reread failed (ignored)", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      const tok = await refreshDaemonToken(basis.hubUrl, basis.refreshToken);
      const next: UserAuthRecord = {
        ...basis,
        accessToken: tok.accessToken,
        refreshToken: tok.refreshToken,
        expiresAt: Date.now() + tok.expiresIn * 1000,
        hubUrl: tok.hubUrl || basis.hubUrl,
      };
      saveUserAuth(next, this.file);
      this.record = next;
      daemonLog.info("user-auth refresh: ok", {
        userId: next.userId,
        expiresAt: next.expiresAt,
      });
      return next;
    })().catch((err) => {
      const status =
        typeof (err as { status?: unknown }).status === "number"
          ? ((err as { status: number }).status)
          : null;
      const message = err instanceof Error ? err.message : String(err);
      daemonLog.warn("user-auth refresh: failed", {
        userId: current.userId,
        status,
        error: message,
      });
      if (status === 401 || status === 403) {
        // Refresh token is permanently dead — write the expired flag so
        // `status` surfaces it and re-throw a typed error so the control
        // channel can stop reconnect loops instead of hammering the Hub.
        writeAuthExpiredFlag();
        throw new AuthRefreshRejectedError(status, message);
      }
      throw err;
    }).finally(() => {
      this.refreshInflight = null;
    });
    return this.refreshInflight;
  }

  /** Replace the record in memory and on disk (e.g. after device-code login). */
  replace(record: UserAuthRecord): void {
    saveUserAuth(record, this.file);
    this.record = record;
    clearAuthExpiredFlag();
    daemonLog.info("user-auth replaced", {
      userId: record.userId,
      hubUrl: record.hubUrl,
    });
  }

  /** Drop the record from memory + disk (e.g. after a hard revoke). */
  clear(): void {
    const prevUserId = this.record?.userId ?? null;
    clearUserAuth(this.file);
    this.record = null;
    daemonLog.info("user-auth manager cleared", { userId: prevUserId });
  }
}
