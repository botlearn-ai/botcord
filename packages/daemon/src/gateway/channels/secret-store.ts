import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

// W3: logger for corrupt-file warnings. Using console so no circular dep on log.ts.
const _warn = (msg: string) => console.warn(`[secret-store] ${msg}`);

const DEFAULT_GATEWAYS_DIR = path.join(
  homedir(),
  ".botcord",
  "daemon",
  "gateways",
);

/**
 * Resolve the on-disk secret-file path for a third-party gateway. Honors an
 * explicit override when provided; otherwise falls back to
 * `~/.botcord/daemon/gateways/{id}.json` (mode 0600 inside a 0700 dir).
 */
export function defaultGatewaySecretPath(
  gatewayId: string,
  override?: string,
): string {
  if (override && override.length > 0) return override;
  return path.join(DEFAULT_GATEWAYS_DIR, `${gatewayId}.json`);
}

/**
 * Load a previously-written secret blob. Returns `null` when the file is
 * absent — callers treat that as "not yet authorized" rather than an error.
 */
export function loadGatewaySecret<T = Record<string, unknown>>(
  gatewayId: string,
  override?: string,
): T | null {
  const file = defaultGatewaySecretPath(gatewayId, override);
  if (!existsSync(file)) return null;
  const raw = readFileSync(file, "utf8");
  // W3: guard against corrupt files — JSON.parse throws on malformed input.
  try {
    return JSON.parse(raw) as T;
  } catch {
    _warn(`corrupt secret file at ${file} — ignoring`);
    return null;
  }
}

/**
 * Persist a secret blob with mode `0600`, ensuring the parent directory
 * exists with mode `0700`. Writes go through a `.tmp` rename for atomicity.
 *
 * The parent directory mode is re-applied on every write so a permission
 * drift (e.g. operator chmod) is corrected the next time the daemon writes.
 */
export function saveGatewaySecret(
  gatewayId: string,
  secret: Record<string, unknown>,
  override?: string,
): string {
  const file = defaultGatewaySecretPath(gatewayId, override);
  const dir = path.dirname(file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    // best-effort
  }
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(secret, null, 2), { mode: 0o600 });
  try {
    chmodSync(tmp, 0o600);
  } catch {
    // best-effort
  }
  renameSync(tmp, file);
  try {
    chmodSync(file, 0o600);
  } catch {
    // best-effort
  }
  return file;
}

/** Remove a previously-saved secret. No-op when the file is missing. */
export function deleteGatewaySecret(
  gatewayId: string,
  override?: string,
): void {
  const file = defaultGatewaySecretPath(gatewayId, override);
  if (!existsSync(file)) return;
  unlinkSync(file);
}
