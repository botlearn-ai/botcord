import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { DaemonConfig, OpenclawGatewayProfile } from "./config.js";
import { log as daemonLog } from "./log.js";
import { probeOpenclawAgents, type WsEndpointProbeFn } from "./provision.js";

export type DiscoveredOpenclawGatewaySource = "config-file" | "env" | "default-port";

export interface DiscoveredOpenclawGateway {
  name: string;
  url: string;
  token?: string;
  tokenFile?: string;
  source: DiscoveredOpenclawGatewaySource;
}

export interface OpenclawGatewayDiscoveryOptions {
  searchPaths?: string[];
  defaultPorts?: number[];
  probe?: WsEndpointProbeFn;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

export interface MergeOpenclawGatewayResult {
  cfg: DaemonConfig;
  changed: boolean;
  added: OpenclawGatewayProfile[];
}

const DEFAULT_SEARCH_PATHS = ["~/.openclaw/", "/etc/openclaw/"];
const DEFAULT_PORTS = [18789];

export async function discoverLocalOpenclawGateways(
  opts: OpenclawGatewayDiscoveryOptions = {},
): Promise<DiscoveredOpenclawGateway[]> {
  const found: DiscoveredOpenclawGateway[] = [];
  for (const root of opts.searchPaths ?? DEFAULT_SEARCH_PATHS) {
    found.push(...discoverFromConfigDir(root));
  }

  const env = opts.env ?? process.env;
  const envUrl = env.OPENCLAW_ACP_URL;
  if (envUrl) {
    const item: DiscoveredOpenclawGateway = {
      name: nameFromUrl(envUrl),
      url: envUrl,
      source: "env",
    };
    if (env.OPENCLAW_ACP_TOKEN) item.token = env.OPENCLAW_ACP_TOKEN;
    else if (env.OPENCLAW_ACP_TOKEN_FILE) item.tokenFile = env.OPENCLAW_ACP_TOKEN_FILE;
    found.push(item);
  }

  const ports = opts.defaultPorts ?? DEFAULT_PORTS;
  if (ports.length > 0) {
    await Promise.all(
      ports.map(async (port) => {
        const url = `ws://127.0.0.1:${port}`;
        try {
          const res = await probeOpenclawAgents(
            { url },
            { probe: opts.probe, timeoutMs: opts.timeoutMs },
          );
          if (res.ok) {
            found.push({ name: nameFromUrl(url), url, source: "default-port" });
          }
        } catch (err) {
          daemonLog.debug("openclaw discovery default-port probe failed", {
            url,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }),
    );
  }

  return dedupeDiscovered(found);
}

export function mergeOpenclawGateways(
  cfg: DaemonConfig,
  found: DiscoveredOpenclawGateway[],
): MergeOpenclawGatewayResult {
  const existing = cfg.openclawGateways ?? [];
  const byUrl = new Map<string, number>();
  existing.forEach((g, i) => byUrl.set(normalizeUrlKey(g.url), i));
  const existingNames = new Set(existing.map((g) => g.name));
  const merged = existing.map((g) => ({ ...g }));
  const added: OpenclawGatewayProfile[] = [];
  let mutated = false;

  for (const item of found) {
    const key = normalizeUrlKey(item.url);
    const idx = byUrl.get(key);
    if (idx !== undefined) {
      // Same URL already configured — only fill in auth that the user is
      // missing, never overwrite an existing token / tokenFile.
      const cur = merged[idx];
      if (!cur.token && !cur.tokenFile) {
        if (item.token) {
          cur.token = item.token;
          mutated = true;
        } else if (item.tokenFile) {
          cur.tokenFile = item.tokenFile;
          mutated = true;
        }
      }
      continue;
    }
    const profile: OpenclawGatewayProfile = {
      name: uniqueName(item.name, existingNames),
      url: item.url,
    };
    if (item.token) profile.token = item.token;
    else if (item.tokenFile) profile.tokenFile = item.tokenFile;
    byUrl.set(key, merged.length);
    existingNames.add(profile.name);
    merged.push(profile);
    added.push(profile);
  }

  if (added.length === 0 && !mutated) return { cfg, changed: false, added };
  return {
    cfg: { ...cfg, openclawGateways: merged },
    changed: true,
    added,
  };
}

function discoverFromConfigDir(root: string): DiscoveredOpenclawGateway[] {
  const dir = expandHome(root);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: DiscoveredOpenclawGateway[] = [];
  for (const name of names.sort()) {
    if (!name.endsWith(".json") && !name.endsWith(".toml")) continue;
    const file = path.join(dir, name);
    try {
      const st = statSync(file);
      if (!st.isFile()) continue;
      const raw = readFileSync(file, "utf8");
      const parsed = name.endsWith(".json") ? parseJsonConfig(raw) : parseTomlConfig(raw);
      if (!parsed?.url) continue;
      const item: DiscoveredOpenclawGateway = {
        name: nameFromUrl(parsed.url),
        url: parsed.url,
        source: "config-file",
      };
      if (parsed.token) item.token = parsed.token;
      else if (parsed.tokenFile) item.tokenFile = parsed.tokenFile;
      out.push(item);
    } catch (err) {
      daemonLog.debug("openclaw discovery config skipped", {
        file,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return out;
}

function parseJsonConfig(raw: string): { url?: string; token?: string; tokenFile?: string } | null {
  const obj = JSON.parse(raw) as any;
  // Prefer OpenClaw's native shape: `gateway.port` + `gateway.auth.token`.
  // The legacy `acp.url` shape is also supported for explicit user-authored configs.
  const native = pickOpenclawGatewayValues(obj?.gateway);
  if (native) return native;
  const acp = obj?.acp ?? obj?.gateway?.acp ?? obj?.gateway ?? obj;
  return pickConfigValues(acp);
}

function pickOpenclawGatewayValues(
  gw: any,
): { url?: string; token?: string; tokenFile?: string } | null {
  if (!gw || typeof gw !== "object") return null;
  const port = typeof gw.port === "number" ? gw.port : undefined;
  if (!port) return null;
  // Local discovery always targets the loopback interface, regardless of how
  // the gateway is bound — the daemon is on the same machine.
  const url = `ws://127.0.0.1:${port}`;
  const auth = gw.auth;
  const out: { url: string; token?: string; tokenFile?: string } = { url };
  if (auth && typeof auth === "object" && auth.mode === "token") {
    if (typeof auth.token === "string" && auth.token.trim()) out.token = auth.token.trim();
    else if (typeof auth.tokenFile === "string" && auth.tokenFile.trim()) {
      out.tokenFile = auth.tokenFile.trim();
    }
  }
  return out;
}

function parseTomlConfig(raw: string): { url?: string; token?: string; tokenFile?: string } | null {
  let inAcp = false;
  const values: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.replace(/#.*/, "").trim();
    if (!trimmed) continue;
    const section = trimmed.match(/^\[([^\]]+)\]$/);
    if (section) {
      inAcp = section[1] === "acp" || section[1].endsWith(".acp");
      continue;
    }
    if (!inAcp) continue;
    const m = trimmed.match(/^([A-Za-z0-9_-]+)\s*=\s*"(.*)"\s*$/);
    if (m) values[m[1]] = m[2];
  }
  return pickConfigValues(values);
}

function pickConfigValues(obj: any): { url?: string; token?: string; tokenFile?: string } | null {
  if (!obj || typeof obj !== "object") return null;
  const url = pickString(obj, ["url", "wsUrl", "ws_url", "endpoint"]);
  if (!url) return null;
  const token = pickString(obj, ["token", "bearerToken", "bearer_token"]);
  const tokenFile = pickString(obj, ["tokenFile", "token_file"]);
  return { url, token, tokenFile };
}

function pickString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function dedupeDiscovered(items: DiscoveredOpenclawGateway[]): DiscoveredOpenclawGateway[] {
  const priority: Record<DiscoveredOpenclawGatewaySource, number> = {
    "config-file": 3,
    env: 2,
    "default-port": 1,
  };
  const byUrl = new Map<string, DiscoveredOpenclawGateway>();
  for (const item of items) {
    const key = normalizeUrlKey(item.url);
    const prev = byUrl.get(key);
    if (!prev || priority[item.source] > priority[prev.source] || hasMoreAuth(item, prev)) {
      byUrl.set(key, item);
    }
  }
  return [...byUrl.values()];
}

function hasMoreAuth(a: DiscoveredOpenclawGateway, b: DiscoveredOpenclawGateway): boolean {
  const score = (x: DiscoveredOpenclawGateway): number => (x.token ? 2 : x.tokenFile ? 1 : 0);
  return score(a) > score(b);
}

function nameFromUrl(raw: string): string {
  try {
    const u = new URL(raw);
    const base = `${u.hostname}-${u.port || (u.protocol === "wss:" ? "443" : "80")}`;
    return `openclaw-${base.replace(/[^A-Za-z0-9_-]+/g, "-")}`;
  } catch {
    return "openclaw-local";
  }
}

function uniqueName(base: string, existing: Set<string>): string {
  let candidate = base;
  let i = 2;
  while (existing.has(candidate)) {
    candidate = `${base}-${i}`;
    i += 1;
  }
  return candidate;
}

function normalizeUrlKey(raw: string): string {
  try {
    const u = new URL(raw);
    u.hash = "";
    return u.toString();
  } catch {
    return raw.trim();
  }
}

function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return path.join(homedir(), p.slice(2));
  return p;
}

export function defaultOpenclawDiscoverySearchPaths(): string[] {
  return DEFAULT_SEARCH_PATHS.slice();
}

export function defaultOpenclawDiscoveryPorts(): number[] {
  return DEFAULT_PORTS.slice();
}

export function openclawDiscoveryConfigEnabled(cfg: DaemonConfig): boolean {
  return cfg.openclawDiscovery?.enabled !== false;
}

export function openclawAutoProvisionEnabled(cfg: DaemonConfig): boolean {
  return cfg.openclawDiscovery?.autoProvision !== false;
}
