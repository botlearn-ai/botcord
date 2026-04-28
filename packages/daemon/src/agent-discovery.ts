import { readdirSync, statSync, type Stats } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
  defaultCredentialsFile,
  loadStoredCredentials,
  type StoredBotCordCredentials,
} from "@botcord/protocol-core";
import type { DaemonConfig } from "./config.js";
import { resolveConfiguredAgentIds } from "./config.js";
import { log as daemonLog } from "./log.js";

/**
 * Default location daemon looks at when discovering BotCord credentials at
 * boot. Matches the path the `botcord` CLI and plugin write to.
 */
export const DEFAULT_CREDENTIALS_DIR = path.join(
  homedir(),
  ".botcord",
  "credentials",
);

/**
 * One local BotCord identity discovered at boot. The canonical id is the
 * credential file's internal `agentId`, not the filename — a stale copy
 * saved under a wrong name still binds to its true agent.
 */
export interface DiscoveredAgentCredential {
  agentId: string;
  credentialsFile: string;
  hubUrl: string;
  displayName?: string;
  /**
   * Runtime cached in the credentials file. Null for legacy bind-code
   * credentials without the field; the daemon falls back to `defaultRoute`
   * in that case.
   */
  runtime?: string;
  /** Working directory cached alongside `runtime`. */
  cwd?: string;
  /** OpenClaw gateway profile name from credentials (only meaningful for openclaw-acp). */
  openclawGateway?: string;
  /** OpenClaw agent profile override from credentials. */
  openclawAgent?: string;
  /** Key id from the credentials file — surfaced so boot-time workspace
   * seeding (see daemon-agent-workspace-plan.md §9) can render identity.md
   * without re-reading the file. */
  keyId?: string;
  /** ISO timestamp of when the credentials file was written. */
  savedAt?: string;
}

/** Result of one discovery pass — explicit about what was dropped and why. */
export interface AgentDiscoveryResult {
  agents: DiscoveredAgentCredential[];
  warnings: string[];
}

/** Minimal surface the discovery module needs from `node:fs`. Injectable for tests. */
export interface DiscoveryFs {
  readDir?: (dir: string) => string[];
  stat?: (p: string) => Stats;
  loadCredentials?: (file: string) => StoredBotCordCredentials;
}

export interface DiscoveryOptions extends DiscoveryFs {
  /** Directory to scan. Defaults to {@link DEFAULT_CREDENTIALS_DIR}. */
  credentialsDir?: string;
  /**
   * Optional daemon target Hub. When set, auto-discovered credentials whose
   * hubUrl points at a different host are skipped so preview/prod identities
   * are not mixed by accident.
   */
  expectedHubUrl?: string;
}

/**
 * Scan the credentials directory and return one entry per valid BotCord
 * credential file. Tolerant by design: missing directory, non-JSON files,
 * unparseable JSON, credentials missing required fields, and duplicate
 * `agentId` entries are all skipped with a warning — never thrown.
 *
 * Duplicate policy is deterministic: prefer the file with the newer
 * `mtimeMs`; if equal/unavailable, prefer lexical path order. This avoids
 * surprising channel selection when stale copies sit alongside fresh ones.
 */
export function discoverAgentCredentials(
  opts: DiscoveryOptions = {},
): AgentDiscoveryResult {
  const dir = opts.credentialsDir ?? DEFAULT_CREDENTIALS_DIR;
  const readDir = opts.readDir ?? ((d: string) => readdirSync(d));
  const stat = opts.stat ?? ((p: string) => statSync(p));
  const loadCreds = opts.loadCredentials ?? loadStoredCredentials;

  const warnings: string[] = [];

  let entries: string[];
  try {
    entries = readDir(dir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      daemonLog.debug("credentials dir missing", { dir });
      return { agents: [], warnings };
    }
    warnings.push(`credentials dir unreadable (${dir}): ${errMsg(err)}`);
    return { agents: [], warnings };
  }
  daemonLog.debug("credentials dir scan", { dir, entryCount: entries.length });

  // Sort filenames lexically so the duplicate tie-breaker is deterministic
  // regardless of filesystem ordering.
  const files = entries
    .filter((name) => name.endsWith(".json"))
    .map((name) => path.join(dir, name))
    .sort();

  interface Candidate {
    creds: StoredBotCordCredentials;
    credentialsFile: string;
    mtimeMs: number;
  }

  const byAgent = new Map<string, Candidate>();

  for (const file of files) {
    let mtimeMs = 0;
    try {
      mtimeMs = stat(file).mtimeMs;
    } catch {
      // mtime is best-effort; fall back to 0 so lexical order wins ties.
    }

    let creds: StoredBotCordCredentials;
    try {
      creds = loadCreds(file);
    } catch (err) {
      warnings.push(`invalid credentials at ${file}: ${errMsg(err)}`);
      continue;
    }

    if (typeof creds.agentId !== "string" || creds.agentId.length === 0) {
      warnings.push(`credentials at ${file} missing agentId; skipped`);
      continue;
    }
    if (opts.expectedHubUrl && !sameHubHost(creds.hubUrl, opts.expectedHubUrl)) {
      warnings.push(
        `credential skipped: hubUrl does not match daemon environment (${file})`,
      );
      continue;
    }

    const existing = byAgent.get(creds.agentId);
    if (!existing) {
      byAgent.set(creds.agentId, { creds, credentialsFile: file, mtimeMs });
      continue;
    }

    // Duplicate: pick newer mtime; ties fall through to the entry we saw
    // first (lexically earlier thanks to the sort above).
    if (mtimeMs > existing.mtimeMs) {
      warnings.push(
        `duplicate agentId "${creds.agentId}": preferring ${file} over ${existing.credentialsFile} (newer mtime)`,
      );
      byAgent.set(creds.agentId, { creds, credentialsFile: file, mtimeMs });
    } else {
      warnings.push(
        `duplicate agentId "${creds.agentId}": keeping ${existing.credentialsFile}, ignoring ${file}`,
      );
    }
  }

  const agents: DiscoveredAgentCredential[] = [];
  for (const { creds, credentialsFile } of byAgent.values()) {
    const entry: DiscoveredAgentCredential = {
      agentId: creds.agentId,
      credentialsFile,
      hubUrl: creds.hubUrl,
    };
    if (creds.displayName) entry.displayName = creds.displayName;
    if (creds.runtime) entry.runtime = creds.runtime;
    if (creds.cwd) entry.cwd = creds.cwd;
    if (creds.openclawGateway) entry.openclawGateway = creds.openclawGateway;
    if (creds.openclawAgent) entry.openclawAgent = creds.openclawAgent;
    if (creds.keyId) entry.keyId = creds.keyId;
    if (creds.savedAt) entry.savedAt = creds.savedAt;
    agents.push(entry);
  }
  // Stable order for downstream channel creation / logs.
  agents.sort((a, b) => a.agentId.localeCompare(b.agentId));
  daemonLog.debug("credentials discovery done", {
    dir,
    agentCount: agents.length,
    warningCount: warnings.length,
  });
  return { agents, warnings };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sameHubHost(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return true;
  try {
    return new URL(a).host === new URL(b).host;
  } catch {
    return true;
  }
}

/** Result of composing explicit config + discovery into the final boot list. */
export interface BootAgentsResult {
  /** Ordered list of agents the daemon should bind channels for. */
  agents: DiscoveredAgentCredential[];
  /** "config" — explicit `agents`/`agentId`; "credentials" — discovery. */
  source: "config" | "credentials";
  /** Resolved discovery directory (informational, for logs/status). */
  credentialsDir: string;
  /** Non-fatal issues surfaced by discovery, passed through for logging. */
  warnings: string[];
}

/**
 * Resolve the list of agents the daemon should bind at boot.
 *
 * Order of precedence:
 *   1. `cfg.agents` / legacy `cfg.agentId` — channel credentials default to
 *      `~/.botcord/credentials/<agentId>.json`.
 *   2. If neither is set, discover credentials from disk (unless
 *      `agentDiscovery.enabled === false`, in which case the caller should
 *      already have errored in `loadConfig`).
 */
export function resolveBootAgents(
  cfg: DaemonConfig,
  opts: DiscoveryOptions = {},
): BootAgentsResult {
  const credentialsDir =
    opts.credentialsDir ?? cfg.agentDiscovery?.credentialsDir ?? DEFAULT_CREDENTIALS_DIR;

  const explicit = resolveConfiguredAgentIds(cfg);
  daemonLog.debug("resolveBootAgents", {
    credentialsDir,
    source: explicit ? "config" : "credentials",
    explicitCount: explicit?.length ?? 0,
  });
  if (explicit) {
    // Best-effort enrich with runtime/cwd cached in credentials. A missing
    // or unreadable file is not fatal — the gateway channel will surface the
    // real error at start. The fields we're after are purely for router
    // fallback.
    const agents: DiscoveredAgentCredential[] = explicit.map((agentId) => {
      const credentialsFile = defaultCredentialsFile(agentId);
      const entry: DiscoveredAgentCredential = {
        agentId,
        credentialsFile,
        hubUrl: "",
      };
      const load = opts.loadCredentials ?? loadStoredCredentials;
      try {
        const creds = load(credentialsFile);
        if (creds.hubUrl) entry.hubUrl = creds.hubUrl;
        if (creds.displayName) entry.displayName = creds.displayName;
        if (creds.runtime) entry.runtime = creds.runtime;
        if (creds.cwd) entry.cwd = creds.cwd;
        if (creds.openclawGateway) entry.openclawGateway = creds.openclawGateway;
        if (creds.openclawAgent) entry.openclawAgent = creds.openclawAgent;
        if (creds.keyId) entry.keyId = creds.keyId;
        if (creds.savedAt) entry.savedAt = creds.savedAt;
      } catch (err) {
        // Silent on any read failure: the file may not exist yet (it gets
        // written by provision flows or legacy CLI) and the gateway channel
        // is the one that surfaces real errors at start. This enrichment
        // is purely opportunistic — missing runtime/cwd just means the
        // router falls back to `defaultRoute`, which is the pre-plan
        // behavior.
        void err;
      }
      return entry;
    });
    return { agents, source: "config", credentialsDir, warnings: [] };
  }

  const discovery = discoverAgentCredentials({ ...opts, credentialsDir });
  return {
    agents: discovery.agents,
    source: "credentials",
    credentialsDir,
    warnings: discovery.warnings,
  };
}
