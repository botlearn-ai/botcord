import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const DAEMON_DIR = path.join(homedir(), ".botcord", "daemon");
const CONFIG_PATH = path.join(DAEMON_DIR, "config.json");
export const PID_PATH = path.join(DAEMON_DIR, "daemon.pid");
export const SESSIONS_PATH = path.join(DAEMON_DIR, "sessions.json");

export type AdapterName = "claude-code" | "codex" | "gemini";

export interface RouteRule {
  /** Match on either an explicit room_id or a prefix like "rm_oc_". First match wins. */
  match: { roomId?: string; roomPrefix?: string };
  adapter: AdapterName;
  cwd: string;
  /** Extra CLI flags appended to the adapter invocation. */
  extraArgs?: string[];
}

export interface DaemonConfig {
  /** Agent to bind this daemon to. Credentials come from ~/.botcord/credentials/{agentId}.json. */
  agentId: string;
  /** Default adapter + cwd used when no route matches. */
  defaultRoute: {
    adapter: AdapterName;
    cwd: string;
    extraArgs?: string[];
  };
  routes: RouteRule[];
  /** If true, stream blocks (only meaningful for rm_oc_* rooms). */
  streamBlocks: boolean;
}

function ensureDir(): void {
  try {
    mkdirSync(DAEMON_DIR, { recursive: true, mode: 0o700 });
  } catch {
    // best-effort
  }
}

export function loadConfig(): DaemonConfig {
  if (!existsSync(CONFIG_PATH)) {
    throw new Error(
      `daemon config not found at ${CONFIG_PATH}. Run \`botcord-daemon init --agent <ag_xxx>\` first.`,
    );
  }
  const raw = readFileSync(CONFIG_PATH, "utf8");
  const parsed = JSON.parse(raw) as Partial<DaemonConfig>;
  if (!parsed.agentId) throw new Error(`daemon config missing agentId (${CONFIG_PATH})`);
  if (!parsed.defaultRoute?.adapter || !parsed.defaultRoute?.cwd) {
    throw new Error(`daemon config missing defaultRoute.adapter/cwd (${CONFIG_PATH})`);
  }
  return {
    agentId: parsed.agentId,
    defaultRoute: parsed.defaultRoute,
    routes: parsed.routes ?? [],
    streamBlocks: parsed.streamBlocks ?? true,
  };
}

export function saveConfig(cfg: DaemonConfig): void {
  ensureDir();
  const tmp = CONFIG_PATH + ".tmp";
  writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  renameSync(tmp, CONFIG_PATH);
}

export function initDefaultConfig(agentId: string, cwd: string = homedir()): DaemonConfig {
  return {
    agentId,
    defaultRoute: { adapter: "claude-code", cwd },
    routes: [],
    streamBlocks: true,
  };
}

export const CONFIG_FILE_PATH = CONFIG_PATH;
export const DAEMON_DIR_PATH = DAEMON_DIR;
