/**
 * Plugin version negotiation with the BotCord Hub.
 *
 * Compares the local plugin version against `latest_plugin_version` and
 * `min_plugin_version` returned by the Hub during token refresh / WS auth.
 * Emits warnings or errors via the supplied logger.
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { version: PLUGIN_VERSION } = require("../package.json") as { version: string };

export { PLUGIN_VERSION };

export interface VersionInfo {
  latest_plugin_version?: string | null;
  min_plugin_version?: string | null;
}

const SEMVER_RE = /^v?(\d+)\.(\d+)\.(\d+)/;

/**
 * Parse a semver-like string into [major, minor, patch].
 * Accepts optional "v" prefix and ignores pre-release suffixes.
 * Returns null if the string is not a valid semver.
 */
function parseSemver(s: string): [number, number, number] | null {
  const m = SEMVER_RE.exec(s);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/**
 * Simple semver comparison: returns -1 | 0 | 1, or 0 if either is unparseable.
 */
function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return 0; // treat unparseable as equal (no action)
  for (let i = 0; i < 3; i++) {
    const diff = pa[i] - pb[i];
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

/** Has the update warning been emitted this session? Prevents log spam. */
let _warnedThisSession = false;

/**
 * Check version info from Hub and log appropriate warnings.
 * Returns "ok" | "update_available" | "incompatible".
 */
export function checkVersionInfo(
  info: VersionInfo,
  log?: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void },
): "ok" | "update_available" | "incompatible" {
  const { latest_plugin_version, min_plugin_version } = info;

  // Check minimum compatibility first
  if (min_plugin_version && compareSemver(PLUGIN_VERSION, min_plugin_version) < 0) {
    log?.error(
      `[BotCord] Plugin version ${PLUGIN_VERSION} is below the minimum required ${min_plugin_version}. ` +
      `Please update: openclaw plugins install @botcord/botcord@latest`,
    );
    return "incompatible";
  }

  // Check if a newer version is available
  if (latest_plugin_version && compareSemver(PLUGIN_VERSION, latest_plugin_version) < 0) {
    if (!_warnedThisSession) {
      _warnedThisSession = true;
      log?.warn(
        `[BotCord] New version available: ${latest_plugin_version} (current: ${PLUGIN_VERSION}). ` +
        `Update: openclaw plugins install @botcord/botcord@latest`,
      );
    }
    return "update_available";
  }

  return "ok";
}

/** Reset the session-level dedup flag (for testing). */
export function _resetWarningFlag(): void {
  _warnedThisSession = false;
}
