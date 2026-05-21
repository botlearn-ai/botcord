/**
 * Cloud-daemon auth manager.
 *
 * Implements the subset of `UserAuthManager` surface that `ControlChannel`
 * uses (`current`, `ensureAccessToken`) so the same channel implementation
 * can be reused for `/cloud/daemon/ws`. Unlike the user variant there is
 * no refresh token: the Hub-managed E2B provider rotates the access token
 * by relaunching the daemon. When the embedded JWT expires, the WS server
 * closes with 4401 and `ControlChannel.onClose` writes the auth-expired
 * flag — at which point the provider would resume the sandbox with a
 * fresh token.
 *
 * Plan §6.4: `auth-expired.flag` is still written so any external monitor
 * watching the sandbox filesystem can detect the situation; the cloud
 * provider doesn't read this file directly today (it relies on
 * `daemon_instances.last_seen_at` going stale instead).
 *
 * Field names match `UserAuthRecord` for drop-in compatibility with
 * `ControlChannel.start()` which reads `auth.current.{userId,hubUrl,label}`.
 */
import type { UserAuthRecord, UserAuthManager } from "./user-auth.js";
import type { CloudModeConfig } from "./cloud-mode.js";

/**
 * Minimal `UserAuthManager`-shaped wrapper backed by the cloud-mode env
 * vars. Static-typed against `UserAuthManager` so `ControlChannel` accepts
 * it without an interface change.
 */
export class CloudAuthManager {
  private record: UserAuthRecord;

  constructor(cfg: CloudModeConfig) {
    this.record = {
      version: 1,
      // The cloud daemon row is owned by a single user — but we don't get
      // the user id in the env (the JWT carries it server-side). Surface
      // the cloud daemon instance id as a stable "who am I" string for
      // logs; the Hub already knows the binding.
      userId: cfg.cloudDaemonInstanceId,
      daemonInstanceId: cfg.daemonInstanceId,
      hubUrl: cfg.hubUrl,
      accessToken: cfg.accessToken,
      // No refresh token in cloud mode. Stored as an empty string to keep
      // the type intact; `ensureAccessToken` never reaches the refresh path
      // because `expiresAt` is set to a date far in the future (the Hub
      // closes the WS with 4401 when the embedded JWT expires).
      refreshToken: "",
      expiresAt: Number.MAX_SAFE_INTEGER,
      loggedInAt: new Date().toISOString(),
      label: `cloud:${cfg.cloudDaemonInstanceId}`,
    };
  }

  get current(): UserAuthRecord {
    return this.record;
  }

  /**
   * Cloud-mode access token never refreshes locally — it's baked into the
   * JWT the provider injected at sandbox start. The provider rotates by
   * relaunching the daemon, not by talking to a refresh endpoint.
   */
  async ensureAccessToken(): Promise<string> {
    return this.record.accessToken;
  }
}

/**
 * Hand the cloud auth wrapper out as a `UserAuthManager` so `ControlChannel`
 * (which only consults `current` and `ensureAccessToken`) accepts it.
 *
 * Cast-only — no runtime translation needed because `CloudAuthManager`
 * implements the same shape. Kept as a single helper so the cast is
 * documented in one place.
 */
export function asUserAuthManager(mgr: CloudAuthManager): UserAuthManager {
  return mgr as unknown as UserAuthManager;
}
