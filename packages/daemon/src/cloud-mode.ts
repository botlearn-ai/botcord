/**
 * Cloud-daemon mode detection + env-driven configuration.
 *
 * A "cloud daemon" is a `botcord-daemon` process running inside a Hub-managed
 * E2B sandbox. It is configured exclusively through environment variables
 * (no on-disk `user-auth.json`) and connects to `/cloud/daemon/ws` with a
 * `cloud-daemon-access` JWT instead of the device-code-issued user token.
 *
 * The Hub-side provider that launches the daemon is
 * `backend/hub/services/cloud_daemon_provider_e2b.py` — keep the env-var
 * names below in sync with `_build_env` there.
 *
 * See ``docs/cloud-agent-technical-design.md`` §3-4.
 */

/** Names of the environment variables the cloud provider injects. */
export const CLOUD_ENV_VARS = {
  HUB_URL: "BOTCORD_HUB_URL",
  CLOUD_DAEMON_INSTANCE_ID: "BOTCORD_CLOUD_DAEMON_INSTANCE_ID",
  DAEMON_INSTANCE_ID: "BOTCORD_DAEMON_INSTANCE_ID",
  ACCESS_TOKEN: "BOTCORD_CLOUD_DAEMON_ACCESS_TOKEN",
} as const;

/** Resolved cloud-mode configuration. All fields are required when present. */
export interface CloudModeConfig {
  hubUrl: string;
  cloudDaemonInstanceId: string;
  daemonInstanceId: string;
  accessToken: string;
}

/**
 * Detection signal — true when `BOTCORD_CLOUD_DAEMON_ACCESS_TOKEN` is set.
 *
 * The access-token presence is the canonical mode switch (matches the
 * provider contract — the token is the one piece the sandbox can't forge).
 * Other env vars may be set during development without flipping mode.
 */
export function isCloudMode(env: NodeJS.ProcessEnv = process.env): boolean {
  const token = env[CLOUD_ENV_VARS.ACCESS_TOKEN];
  return typeof token === "string" && token.length > 0;
}

/**
 * Resolve the cloud-mode configuration from env vars. Throws when a required
 * variable is missing — the daemon must fail fast instead of falling through
 * to the local-mode codepath with partial cloud config.
 *
 * `BOTCORD_DAEMON_INSTANCE_ID` is allowed to fall back to the cloud daemon
 * id when omitted in tests, but in production the provider always sets it.
 */
export function loadCloudModeConfig(
  env: NodeJS.ProcessEnv = process.env,
): CloudModeConfig {
  const requireString = (name: string): string => {
    const v = env[name];
    if (typeof v !== "string" || v.length === 0) {
      throw new Error(
        `cloud-daemon mode: required env var "${name}" is missing or empty`,
      );
    }
    return v;
  };
  return {
    hubUrl: requireString(CLOUD_ENV_VARS.HUB_URL),
    cloudDaemonInstanceId: requireString(CLOUD_ENV_VARS.CLOUD_DAEMON_INSTANCE_ID),
    daemonInstanceId: requireString(CLOUD_ENV_VARS.DAEMON_INSTANCE_ID),
    accessToken: requireString(CLOUD_ENV_VARS.ACCESS_TOKEN),
  };
}
