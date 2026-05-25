/**
 * Phase 4 migration: lift residual cloud daemon gateway secrets +
 * profile metadata into the ingress secret store and connection table.
 *
 * Inputs:
 *   - daemon data dir (defaults to `~/.botcord/daemon/gateways`) — holds
 *     `<id>.json` (secret blob) and `<id>.state.json` (cursor — not migrated)
 *   - daemon config (`~/.botcord/daemon/config.json`) — holds the
 *     `thirdPartyGateways` profile array with `type`, `accountId`,
 *     `enabled`, `allowedSenderIds`, etc.
 *
 * The script is intentionally read-only by default (`--apply` to actually
 * write). It never prints raw secret material; tokens/appSecrets are
 * replaced with `[REDACTED len=N]` in any log line.
 *
 * Calling pattern (CLI):
 *
 *   botcord-gateway-ingress migrate \
 *       [--daemon-data-dir <path>] [--daemon-config <path>] \
 *       [--apply] [--force] [--delete-after] [--quiet]
 *
 * Default mode is dry-run: nothing is written, but every action that
 * WOULD happen is logged and the summary `{migrated, skipped, failed}`
 * is printed.
 */

import {
  existsSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { loadConfigFromEnv, type IngressConfig } from "../config.js";
import { consoleLogger, noopLogger, type IngressLogger } from "../log.js";
import { FileSecretStore, type IngressSecretStore } from "../storage/secrets.js";
import { FileSystemIngressStore, type IngressStore } from "../storage/store.js";
import type { GatewayConnection } from "../types.js";

// ---------------------------------------------------------------------------
// Daemon-side shapes (minimal — we hand-parse instead of importing the
// daemon package so the ingress stays cross-package decoupled).
// ---------------------------------------------------------------------------

interface DaemonThirdPartyProfile {
  id: string;
  type: "telegram" | "wechat" | "feishu";
  accountId: string;
  label?: string;
  enabled?: boolean;
  baseUrl?: string;
  allowedSenderIds?: string[];
  allowedChatIds?: string[];
  splitAt?: number;
  appId?: string;
  domain?: "feishu" | "lark";
  userOpenId?: string;
}

interface DaemonGatewaySecret {
  botToken?: string;
  appSecret?: string;
  baseUrl?: string;
}

interface DaemonConfigShape {
  thirdPartyGateways?: DaemonThirdPartyProfile[];
}

// ---------------------------------------------------------------------------
// CLI argument parsing (no external dep — Commander is the daemon's choice;
// the ingress already avoids it).
// ---------------------------------------------------------------------------

export interface MigrateOptions {
  daemonDataDir: string;
  daemonConfigPath: string;
  apply: boolean;
  force: boolean;
  deleteAfter: boolean;
  quiet: boolean;
  // Used by tests to inject the target stores without going through env vars.
  storeOverride?: IngressStore;
  secretsOverride?: IngressSecretStore;
  logOverride?: IngressLogger;
  /** Override clock for deterministic createdAt/updatedAt in tests. */
  nowOverride?: () => number;
}

export interface MigrateSummary {
  migrated: number;
  skipped: number;
  failed: number;
  /** Per-id outcome ledger for tests / orchestrators. */
  results: Array<{
    id: string;
    outcome: "migrated" | "skipped" | "failed";
    reason?: string;
  }>;
}

const HELP_TEXT = `botcord-gateway-ingress migrate — Phase 4 daemon→ingress backfill

Usage:
  botcord-gateway-ingress migrate [options]

Options:
  --daemon-data-dir <path>   Source secret/state directory.
                             Default: $BOTCORD_DAEMON_DATA_DIR or ~/.botcord/daemon/gateways
  --daemon-config <path>     Source daemon config.json (for profile metadata).
                             Default: ~/.botcord/daemon/config.json
  --apply                    Actually write to ingress store (default is dry-run).
  --force                    Overwrite an existing ingress connection with the same id.
  --delete-after             Delete daemon-side secret + state files after a
                             successful --apply migration. No-op without --apply.
  --quiet                    Suppress per-row info logs (summary still printed).
  -h, --help                 Show this help message.

Notes:
  - Default is DRY-RUN. Re-run with --apply to commit.
  - Secrets are NEVER printed; they're rendered as [REDACTED len=N].
  - Ingress destination is configured via the same env vars as the
    'start' command (BOTCORD_INGRESS_DATA_DIR, BOTCORD_INGRESS_SECRET_DIR).
`;

export function parseMigrateArgs(argv: string[]): MigrateOptions | { help: true } {
  const opts: MigrateOptions = {
    daemonDataDir:
      process.env.BOTCORD_DAEMON_DATA_DIR ??
      join(homedir(), ".botcord", "daemon", "gateways"),
    daemonConfigPath: join(homedir(), ".botcord", "daemon", "config.json"),
    apply: false,
    force: false,
    deleteAfter: false,
    quiet: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") return { help: true };
    if (a === "--apply") opts.apply = true;
    else if (a === "--force") opts.force = true;
    else if (a === "--delete-after") opts.deleteAfter = true;
    else if (a === "--quiet") opts.quiet = true;
    else if (a === "--daemon-data-dir") {
      const v = argv[++i];
      if (!v) throw new Error("--daemon-data-dir requires a path");
      opts.daemonDataDir = resolve(v);
    } else if (a === "--daemon-config") {
      const v = argv[++i];
      if (!v) throw new Error("--daemon-config requires a path");
      opts.daemonConfigPath = resolve(v);
    } else {
      throw new Error(`unknown migrate option: ${a}`);
    }
  }
  return opts;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function redactLen(value: string | undefined | null): string {
  if (!value) return "[REDACTED]";
  return `[REDACTED len=${value.length}]`;
}

function readJsonSafely<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

function loadDaemonProfiles(configPath: string): Map<string, DaemonThirdPartyProfile> {
  const cfg = readJsonSafely<DaemonConfigShape>(configPath);
  const map = new Map<string, DaemonThirdPartyProfile>();
  for (const p of cfg?.thirdPartyGateways ?? []) {
    if (typeof p?.id === "string") map.set(p.id, p);
  }
  return map;
}

function listDaemonSecretFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(
      (n) =>
        n.endsWith(".json") &&
        !n.endsWith(".state.json") &&
        !n.endsWith(".tmp"),
    )
    .map((n) => join(dir, n))
    .sort();
}

interface BuildOutcome {
  connection: GatewayConnection;
  secretPayload: Record<string, unknown>;
}

function buildIngressShape(
  profile: DaemonThirdPartyProfile,
  secret: DaemonGatewaySecret,
  now: number,
): BuildOutcome {
  const baseUrl = profile.baseUrl ?? secret.baseUrl;
  const allowedSenderIds = Array.isArray(profile.allowedSenderIds)
    ? [...profile.allowedSenderIds]
    : [];
  const allowedChatIds = Array.isArray(profile.allowedChatIds)
    ? [...profile.allowedChatIds]
    : [];

  if (profile.type === "telegram") {
    if (!secret.botToken) {
      throw new Error("telegram profile missing botToken in secret file");
    }
    const safeConfig: Record<string, unknown> = {
      ...(baseUrl ? { baseUrl } : {}),
      ...(allowedChatIds.length ? { allowedChatIds } : {}),
      ...(allowedSenderIds.length ? { allowedSenderIds } : {}),
      ...(typeof profile.splitAt === "number" ? { splitAt: profile.splitAt } : {}),
    };
    const connection: GatewayConnection = {
      id: profile.id,
      agentId: profile.accountId,
      provider: "telegram",
      ...(profile.label ? { label: profile.label } : {}),
      status: profile.enabled !== false ? "pending" : "disabled",
      enabled: profile.enabled !== false,
      config: safeConfig,
      secretRef: profile.id,
      createdAt: now,
      updatedAt: now,
    };
    return {
      connection,
      secretPayload: {
        botToken: secret.botToken,
        ...(baseUrl ? { baseUrl } : {}),
      },
    };
  }
  if (profile.type === "wechat") {
    if (!secret.botToken) {
      throw new Error("wechat profile missing botToken in secret file");
    }
    const safeConfig: Record<string, unknown> = {
      ...(baseUrl ? { baseUrl } : {}),
      ...(allowedSenderIds.length ? { allowedSenderIds } : {}),
      ...(typeof profile.splitAt === "number" ? { splitAt: profile.splitAt } : {}),
    };
    const connection: GatewayConnection = {
      id: profile.id,
      agentId: profile.accountId,
      provider: "wechat",
      ...(profile.label ? { label: profile.label } : {}),
      status: profile.enabled !== false ? "pending" : "disabled",
      enabled: profile.enabled !== false,
      config: safeConfig,
      secretRef: profile.id,
      createdAt: now,
      updatedAt: now,
    };
    return {
      connection,
      secretPayload: {
        botToken: secret.botToken,
        ...(baseUrl ? { baseUrl } : {}),
      },
    };
  }
  if (profile.type === "feishu") {
    if (!secret.appSecret) {
      throw new Error("feishu profile missing appSecret in secret file");
    }
    if (!profile.appId) {
      throw new Error("feishu profile missing appId in daemon config");
    }
    const domain = profile.domain ?? "feishu";
    const safeConfig: Record<string, unknown> = {
      domain,
      ...(profile.userOpenId ? { userOpenId: profile.userOpenId } : {}),
      ...(allowedSenderIds.length ? { allowedSenderIds } : {}),
      ...(allowedChatIds.length ? { allowedChatIds } : {}),
      ...(typeof profile.splitAt === "number" ? { splitAt: profile.splitAt } : {}),
    };
    const connection: GatewayConnection = {
      id: profile.id,
      agentId: profile.accountId,
      provider: "feishu",
      ...(profile.label ? { label: profile.label } : {}),
      status: profile.enabled !== false ? "pending" : "disabled",
      enabled: profile.enabled !== false,
      config: safeConfig,
      secretRef: profile.id,
      createdAt: now,
      updatedAt: now,
    };
    return {
      connection,
      secretPayload: {
        appId: profile.appId,
        appSecret: secret.appSecret,
        domain,
        ...(profile.userOpenId ? { userOpenId: profile.userOpenId } : {}),
      },
    };
  }
  throw new Error(`unknown provider type: ${(profile as { type: string }).type}`);
}

// ---------------------------------------------------------------------------
// Main migration routine
// ---------------------------------------------------------------------------

export async function runMigrate(
  opts: MigrateOptions,
  config?: IngressConfig,
): Promise<MigrateSummary> {
  const log = opts.logOverride ?? (opts.quiet ? noopLogger : consoleLogger);
  const now = opts.nowOverride ?? Date.now;
  const cfg = config ?? loadConfigFromEnv();

  const store: IngressStore =
    opts.storeOverride ?? new FileSystemIngressStore(cfg.dataDir);
  const secrets: IngressSecretStore =
    opts.secretsOverride ?? new FileSecretStore(cfg.secretDir);

  log.info("migrate starting", {
    daemonDataDir: opts.daemonDataDir,
    daemonConfig: opts.daemonConfigPath,
    apply: opts.apply,
    force: opts.force,
    deleteAfter: opts.deleteAfter,
    ingressDataDir: cfg.dataDir,
    ingressSecretDir: cfg.secretDir,
  });

  const profiles = loadDaemonProfiles(opts.daemonConfigPath);
  const secretFiles = listDaemonSecretFiles(opts.daemonDataDir);
  const summary: MigrateSummary = {
    migrated: 0,
    skipped: 0,
    failed: 0,
    results: [],
  };

  for (const secretFile of secretFiles) {
    const idMatch = /([^/\\]+)\.json$/.exec(secretFile);
    if (!idMatch) continue;
    const id = idMatch[1];
    if (!id) continue;
    try {
      const secret = readJsonSafely<DaemonGatewaySecret>(secretFile);
      if (!secret) {
        log.warn("skip: unreadable secret file", { id });
        summary.skipped += 1;
        summary.results.push({ id, outcome: "skipped", reason: "unreadable" });
        continue;
      }
      const profile = profiles.get(id);
      if (!profile) {
        log.warn("skip: no matching profile in daemon config", { id });
        summary.skipped += 1;
        summary.results.push({
          id,
          outcome: "skipped",
          reason: "no_profile_in_daemon_config",
        });
        continue;
      }
      const existing = store.getConnection(id);
      if (existing && !opts.force) {
        log.warn("skip: ingress connection already exists", {
          id,
          provider: existing.provider,
        });
        summary.skipped += 1;
        summary.results.push({
          id,
          outcome: "skipped",
          reason: "exists_use_force",
        });
        continue;
      }

      const built = buildIngressShape(profile, secret, now());
      log.info("plan migrate", {
        id,
        provider: built.connection.provider,
        agentId: built.connection.agentId,
        ...(profile.label ? { label: profile.label } : {}),
        enabled: built.connection.enabled,
        secret: redactLen(
          (secret.botToken ?? secret.appSecret ?? "") || undefined,
        ),
        overwriting: Boolean(existing),
      });

      if (!opts.apply) {
        // Dry-run — count as skipped (NOT migrated) so caller knows nothing
        // landed yet.
        summary.skipped += 1;
        summary.results.push({ id, outcome: "skipped", reason: "dry_run" });
        continue;
      }

      secrets.write(id, built.secretPayload);
      store.upsertConnection(built.connection);
      summary.migrated += 1;
      summary.results.push({ id, outcome: "migrated" });
      log.info("migrated", {
        id,
        provider: built.connection.provider,
      });

      if (opts.deleteAfter) {
        const stateFile = join(dirname(secretFile), `${id}.state.json`);
        try {
          unlinkSync(secretFile);
        } catch (err) {
          log.warn("delete-after secret failed", {
            id,
            err: redactLen(String(err)),
          });
        }
        if (existsSync(stateFile)) {
          try {
            unlinkSync(stateFile);
          } catch (err) {
            log.warn("delete-after state failed", {
              id,
              err: redactLen(String(err)),
            });
          }
        }
      }
    } catch (err) {
      summary.failed += 1;
      const reason = err instanceof Error ? err.message : String(err);
      log.error("migrate failed", { id, reason });
      summary.results.push({ id, outcome: "failed", reason });
    }
  }

  log.info("migrate summary", {
    migrated: summary.migrated,
    skipped: summary.skipped,
    failed: summary.failed,
    apply: opts.apply,
  });

  return summary;
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

export async function runMigrateCli(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseMigrateArgs(argv);
  } catch (err) {
    console.error(`[ingress] migrate: ${(err as Error).message}`);
    console.error(HELP_TEXT);
    return 2;
  }
  if ("help" in parsed) {
    // Help is a successful exit — operator wants documentation.
    console.log(HELP_TEXT);
    return 0;
  }
  // Use a tiny helper to write a sentinel file the test can detect without
  // making the migrate CLI care about its callers.
  if (process.env.BOTCORD_INGRESS_MIGRATE_HELP_SENTINEL) {
    writeFileSync(
      process.env.BOTCORD_INGRESS_MIGRATE_HELP_SENTINEL,
      HELP_TEXT,
    );
  }
  const summary = await runMigrate(parsed);
  return summary.failed > 0 ? 1 : 0;
}
