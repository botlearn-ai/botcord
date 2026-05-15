import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { getAdapterModule, listAdapterIds } from "./adapters/runtimes.js";

const DAEMON_DIR = path.join(homedir(), ".botcord", "daemon");
const CONFIG_PATH = path.join(DAEMON_DIR, "config.json");
export const PID_PATH = path.join(DAEMON_DIR, "daemon.pid");
export const SESSIONS_PATH = path.join(DAEMON_DIR, "sessions.json");
export const SNAPSHOT_PATH = path.join(DAEMON_DIR, "snapshot.json");

/**
 * Adapter ids. Built-in adapters are enumerated for editor hints; any string
 * accepted by the registry is valid at runtime.
 */
export type AdapterName = "claude-code" | "codex" | "gemini" | "openclaw-acp" | (string & {});

/**
 * One OpenClaw gateway profile. Referenced by `RouteRule.gateway` and
 * `DaemonRouteDefault.gateway` (and `StoredBotCordCredentials.openclawGateway`)
 * via `name`. `tokenFile` is `~`-expanded and read at `toGatewayConfig` time;
 * read failures do not block boot — the gateway becomes unusable but other
 * gateways still work.
 */
export interface OpenclawGatewayProfile {
  name: string;
  url: string;
  /** Bearer token; mutually-exclusive priority is `token > tokenFile`. */
  token?: string;
  tokenFile?: string;
  /** Default OpenClaw agent profile name when a route does not pin one. */
  defaultAgent?: string;
}

/**
 * Predicates selecting messages for a route. `roomId` / `roomPrefix` are
 * legacy aliases retained for backward compatibility with pre-P1 daemon
 * configs; they map to `conversationId` / `conversationPrefix` at boot.
 * First match wins.
 */
export interface RouteRuleMatch {
  /** @deprecated alias for `conversationId`. */
  roomId?: string;
  /** @deprecated alias for `conversationPrefix`. */
  roomPrefix?: string;
  channel?: string;
  accountId?: string;
  conversationId?: string;
  conversationPrefix?: string;
  conversationKind?: "direct" | "group";
  senderId?: string;
  mentioned?: boolean;
}

export interface RouteRule {
  match: RouteRuleMatch;
  adapter: AdapterName;
  cwd: string;
  /** Extra CLI flags appended to the adapter invocation. */
  extraArgs?: string[];
  /**
   * Required when `adapter === "openclaw-acp"`: name of an entry in
   * `DaemonConfig.openclawGateways[]`.
   */
  gateway?: string;
  /** Overrides `OpenclawGatewayProfile.defaultAgent` when set. */
  openclawAgent?: string;
}

export interface DaemonRouteDefault {
  adapter: AdapterName;
  cwd: string;
  extraArgs?: string[];
  /** Same semantics as `RouteRule.gateway`. */
  gateway?: string;
  /** Same semantics as `RouteRule.openclawAgent`. */
  openclawAgent?: string;
}

/**
 * Daemon-layer hook controlling credential auto-discovery at boot. Kept
 * optional so most users never need to touch it; absence means "use the
 * default rule" (enabled unless an explicit `agents`/`agentId` list is
 * already present).
 */
export interface AgentDiscoveryConfig {
  enabled?: boolean;
  credentialsDir?: string;
}

export interface OpenclawDiscoveryConfig {
  /** Defaults to true. */
  enabled?: boolean;
  /** Overrides the local config-file search roots. */
  searchPaths?: string[];
  /** Overrides the local loopback ports to probe. */
  defaultPorts?: number[];
  /** Defaults to false. When false, discovery only persists gateways. */
  autoProvision?: boolean;
}

/** Third-party messaging provider supported by the daemon's channel factory. */
export type ThirdPartyGatewayType = "telegram" | "wechat" | "feishu";

/**
 * One third-party gateway profile bound to a BotCord agent. `id` is the
 * channel id (typically `gw_...` minted by the Hub); `accountId` is the
 * BotCord agent the inbound traffic should be attributed to. Secrets and
 * provider cursors live outside this struct — see `secretFile` and
 * `stateFile`. When omitted, the daemon derives them as
 * `~/.botcord/daemon/gateways/{id}.json` and `{id}.state.json`.
 */
export interface ThirdPartyGatewayProfile {
  id: string;
  type: ThirdPartyGatewayType;
  accountId: string;
  label?: string;
  enabled?: boolean;
  secretFile?: string;
  stateFile?: string;
  allowedSenderIds?: string[];
  allowedChatIds?: string[];
  splitAt?: number;
  baseUrl?: string;
  appId?: string;
  domain?: "feishu" | "lark";
  userOpenId?: string;
}

export interface DaemonConfig {
  /**
   * @deprecated Kept for backward compatibility with pre-multi-agent configs.
   * Normalized in-memory to `agents: [agentId]` when present. New configs
   * written by `init` use `agents` exclusively.
   */
  agentId?: string;

  /**
   * BotCord agent ids this daemon binds to. Each id maps to its own channel
   * whose `id` equals the agentId. Credentials are loaded from
   * `~/.botcord/credentials/{agentId}.json`. Canonical — prefer this over
   * `agentId`.
   *
   * Optional: when both `agents` and `agentId` are absent, the daemon
   * discovers identities from the credentials directory at boot.
   */
  agents?: string[];

  /**
   * Opt-in controls for credential discovery. When omitted, discovery runs
   * iff no explicit `agents`/`agentId` list is present (P1 default).
   */
  agentDiscovery?: AgentDiscoveryConfig;

  /** Default adapter + cwd used when no route matches. */
  defaultRoute: DaemonRouteDefault;
  routes: RouteRule[];
  /** If true, stream blocks (only meaningful for rm_oc_* rooms). */
  streamBlocks: boolean;
  /**
   * Persistent transcript-logging settings (design §3 / §6). Defaults to
   * enabled — see `BOTCORD_TRANSCRIPT` for env-driven temporary overrides.
   */
  transcript?: TranscriptConfig;

  /**
   * Optional registry of OpenClaw gateway endpoints. Routes / managed routes
   * with `adapter === "openclaw-acp"` reference these by `name`. Resolution
   * to {@link ResolvedOpenclawGateway} happens eagerly in `toGatewayConfig`
   * so the dispatcher never re-queries this list.
   */
  openclawGateways?: OpenclawGatewayProfile[];

  /**
   * Daemon-side local OpenClaw discovery. Omitted means enabled with default
   * search paths/ports and automatic adoption of discovered agents.
   */
  openclawDiscovery?: OpenclawDiscoveryConfig;

  /**
   * Third-party messaging gateways (Telegram, WeChat, …) bound to BotCord
   * agents on this daemon. Each entry becomes one channel in the gateway
   * runtime; `enabled === false` entries are filtered out at boot.
   */
  thirdPartyGateways?: ThirdPartyGatewayProfile[];
}

/**
 * Persistent transcript settings (design §6). Default-on — `botcord-daemon
 * transcript disable` sets `enabled=false`, and `transcript enable` flips it back.
 * The env var `BOTCORD_TRANSCRIPT` can override at boot.
 */
export interface TranscriptConfig {
  enabled?: boolean;
}

/**
 * Return the explicit agent-id list written to disk, or `null` when the
 * config has none. P1 gives discovery a chance at boot before failing,
 * so the resolver no longer throws — callers that need a guaranteed list
 * should fall back to `resolveAgentIds` (which still throws) or run the
 * discovery layer first.
 *
 * - `agents` is present and non-empty → use it verbatim.
 * - `agents` empty/missing + `agentId` present → synthesize `[agentId]`.
 * - Both present: if `agentId` is not in `agents`, log a warn and let
 *   `agents` win.
 * - Neither present → return `null` (discovery-eligible).
 *
 * De-duplicates while preserving order.
 */
export function resolveConfiguredAgentIds(cfg: DaemonConfig): string[] | null {
  const agents = Array.isArray(cfg.agents) ? cfg.agents.filter((s) => typeof s === "string" && s.length > 0) : [];
  const legacy = typeof cfg.agentId === "string" && cfg.agentId.length > 0 ? cfg.agentId : null;

  if (agents.length > 0) {
    if (legacy && !agents.includes(legacy)) {
      // Conflicting shapes on disk; `agents` wins per spec. Logged via
      // stderr so users running `config` or `start` can spot the drift —
      // the `log` module isn't imported here to avoid the side-effect of
      // opening the log file from config validation.
      // eslint-disable-next-line no-console
      console.warn(
        `daemon config: legacy agentId "${legacy}" not listed in agents [${agents.join(", ")}]; preferring agents`,
      );
    }
    return dedupe(agents);
  }
  if (legacy) return [legacy];
  return null;
}

/**
 * Legacy strict resolver — preserved for callers that still assume an
 * explicit list on disk (e.g. internal tests, or codepaths that run
 * before discovery). Throws when neither `agents` nor `agentId` is set.
 */
export function resolveAgentIds(cfg: DaemonConfig): string[] {
  const configured = resolveConfiguredAgentIds(cfg);
  if (configured) return configured;
  throw new Error(
    `daemon config missing agents (or legacy agentId) (${CONFIG_PATH})`,
  );
}

function dedupe(xs: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of xs) {
    if (seen.has(x)) continue;
    seen.add(x);
    out.push(x);
  }
  return out;
}

function ensureDir(): void {
  try {
    mkdirSync(DAEMON_DIR, { recursive: true, mode: 0o700 });
  } catch {
    // best-effort
  }
}

export const CONFIG_MISSING = "CONFIG_MISSING";

export function loadConfig(): DaemonConfig {
  if (!existsSync(CONFIG_PATH)) {
    const err = new Error(`daemon config not found at ${CONFIG_PATH}`) as Error & {
      code?: string;
    };
    err.code = CONFIG_MISSING;
    throw err;
  }
  const raw = readFileSync(CONFIG_PATH, "utf8");
  const parsed = JSON.parse(raw) as Partial<DaemonConfig>;

  const hasAgents =
    Array.isArray(parsed.agents) && parsed.agents.some((s) => typeof s === "string" && s.length > 0);
  const hasLegacy = typeof parsed.agentId === "string" && parsed.agentId.length > 0;
  const discovery = parsed.agentDiscovery;
  const discoveryExplicitlyDisabled =
    !!discovery && typeof discovery === "object" && discovery.enabled === false;
  if (!hasAgents && !hasLegacy && discoveryExplicitlyDisabled) {
    throw new Error(
      `daemon config has no agents/agentId and agentDiscovery.enabled=false (${CONFIG_PATH})`,
    );
  }
  if (hasAgents) {
    for (const [i, a] of (parsed.agents as unknown[]).entries()) {
      if (typeof a !== "string" || a.length === 0) {
        throw new Error(`daemon config agents[${i}] must be a non-empty string (${CONFIG_PATH})`);
      }
    }
  }
  if (
    !parsed.defaultRoute ||
    typeof parsed.defaultRoute.adapter !== "string" ||
    typeof parsed.defaultRoute.cwd !== "string"
  ) {
    throw new Error(`daemon config missing defaultRoute.adapter/cwd (${CONFIG_PATH})`);
  }
  validateAdapter(parsed.defaultRoute.adapter, "defaultRoute.adapter");

  const gatewaysRaw = (parsed as Partial<DaemonConfig>).openclawGateways;
  const gatewayNames = new Set<string>();
  if (gatewaysRaw !== undefined) {
    if (!Array.isArray(gatewaysRaw)) {
      throw new Error(
        `daemon config "openclawGateways" must be an array (${CONFIG_PATH})`,
      );
    }
    for (const [i, g] of gatewaysRaw.entries()) {
      if (!g || typeof g !== "object") {
        throw new Error(
          `daemon config openclawGateways[${i}] is not an object (${CONFIG_PATH})`,
        );
      }
      const gg = g as Partial<OpenclawGatewayProfile>;
      if (typeof gg.name !== "string" || gg.name.length === 0) {
        throw new Error(
          `daemon config openclawGateways[${i}].name must be a non-empty string (${CONFIG_PATH})`,
        );
      }
      if (typeof gg.url !== "string" || gg.url.length === 0) {
        throw new Error(
          `daemon config openclawGateways[${i}].url must be a non-empty string (${CONFIG_PATH})`,
        );
      }
      if (gatewayNames.has(gg.name)) {
        throw new Error(
          `daemon config openclawGateways[${i}].name "${gg.name}" duplicated (${CONFIG_PATH})`,
        );
      }
      gatewayNames.add(gg.name);
    }
  }

  const validateGatewayRef = (
    adapter: string,
    gateway: unknown,
    where: string,
  ): void => {
    if (adapter === "openclaw-acp") {
      if (typeof gateway !== "string" || gateway.length === 0) {
        throw new Error(
          `daemon config ${where} adapter "openclaw-acp" requires a "gateway" name (${CONFIG_PATH})`,
        );
      }
      if (!gatewayNames.has(gateway)) {
        throw new Error(
          `daemon config ${where}.gateway "${gateway}" not in openclawGateways (${CONFIG_PATH})`,
        );
      }
    }
  };

  validateGatewayRef(
    parsed.defaultRoute.adapter,
    (parsed.defaultRoute as DaemonRouteDefault).gateway,
    "defaultRoute",
  );

  const routesRaw = parsed.routes ?? [];
  if (!Array.isArray(routesRaw)) {
    throw new Error(`daemon config "routes" must be an array (${CONFIG_PATH})`);
  }
  for (const [i, r] of routesRaw.entries()) {
    if (!r || typeof r !== "object") {
      throw new Error(`daemon config routes[${i}] is not an object (${CONFIG_PATH})`);
    }
    if (typeof r.adapter !== "string" || typeof r.cwd !== "string") {
      throw new Error(
        `daemon config routes[${i}] missing string adapter/cwd (${CONFIG_PATH})`,
      );
    }
    validateAdapter(r.adapter, `routes[${i}].adapter`);
    validateGatewayRef(r.adapter, (r as RouteRule).gateway, `routes[${i}]`);
  }
  // Preserve the on-disk shape as-is so `config` prints what the user wrote.
  // Resolution of agents vs agentId happens at the consumption boundary
  // (`resolveAgentIds`, `toGatewayConfig`).
  const out: DaemonConfig = {
    defaultRoute: parsed.defaultRoute,
    routes: routesRaw,
    streamBlocks: parsed.streamBlocks ?? true,
  };
  if (parsed.transcript && typeof parsed.transcript === "object") {
    const t: TranscriptConfig = {};
    if (typeof parsed.transcript.enabled === "boolean") t.enabled = parsed.transcript.enabled;
    out.transcript = t;
  }
  if (gatewaysRaw && Array.isArray(gatewaysRaw)) {
    out.openclawGateways = (gatewaysRaw as OpenclawGatewayProfile[]).map((g) => {
      const copy: OpenclawGatewayProfile = { name: g.name, url: g.url };
      if (typeof g.token === "string") copy.token = g.token;
      if (typeof g.tokenFile === "string") copy.tokenFile = g.tokenFile;
      if (typeof g.defaultAgent === "string") copy.defaultAgent = g.defaultAgent;
      return copy;
    });
  }
  if (hasAgents) out.agents = (parsed.agents as string[]).slice();
  if (hasLegacy) out.agentId = parsed.agentId;
  if (discovery && typeof discovery === "object") {
    const copy: AgentDiscoveryConfig = {};
    if (typeof discovery.enabled === "boolean") copy.enabled = discovery.enabled;
    if (typeof discovery.credentialsDir === "string" && discovery.credentialsDir.length > 0) {
      copy.credentialsDir = discovery.credentialsDir;
    }
    out.agentDiscovery = copy;
  }
  const openclawDiscovery = parsed.openclawDiscovery;
  if (openclawDiscovery && typeof openclawDiscovery === "object") {
    const copy: OpenclawDiscoveryConfig = {};
    if (typeof openclawDiscovery.enabled === "boolean") copy.enabled = openclawDiscovery.enabled;
    if (Array.isArray(openclawDiscovery.searchPaths)) {
      copy.searchPaths = openclawDiscovery.searchPaths.filter(
        (p): p is string => typeof p === "string" && p.length > 0,
      );
    }
    if (Array.isArray(openclawDiscovery.defaultPorts)) {
      copy.defaultPorts = openclawDiscovery.defaultPorts.filter(
        (p): p is number => Number.isInteger(p) && p > 0 && p < 65536,
      );
    }
    if (typeof openclawDiscovery.autoProvision === "boolean") {
      copy.autoProvision = openclawDiscovery.autoProvision;
    }
    out.openclawDiscovery = copy;
  }
  const tpg = (parsed as Partial<DaemonConfig>).thirdPartyGateways;
  if (tpg !== undefined) {
    if (!Array.isArray(tpg)) {
      throw new Error(
        `daemon config "thirdPartyGateways" must be an array (${CONFIG_PATH})`,
      );
    }
    const seen = new Set<string>();
    for (const [i, g] of tpg.entries()) {
      if (!g || typeof g !== "object") {
        throw new Error(
          `daemon config thirdPartyGateways[${i}] is not an object (${CONFIG_PATH})`,
        );
      }
      const gg = g as Partial<ThirdPartyGatewayProfile>;
      if (typeof gg.id !== "string" || gg.id.length === 0) {
        throw new Error(
          `daemon config thirdPartyGateways[${i}].id must be a non-empty string (${CONFIG_PATH})`,
        );
      }
      if (gg.type !== "telegram" && gg.type !== "wechat" && gg.type !== "feishu") {
        throw new Error(
          `daemon config thirdPartyGateways[${i}].type must be "telegram", "wechat", or "feishu" (${CONFIG_PATH})`,
        );
      }
      if (typeof gg.accountId !== "string" || gg.accountId.length === 0) {
        throw new Error(
          `daemon config thirdPartyGateways[${i}].accountId must be a non-empty string (${CONFIG_PATH})`,
        );
      }
      if (seen.has(gg.id)) {
        throw new Error(
          `daemon config thirdPartyGateways[${i}].id "${gg.id}" duplicated (${CONFIG_PATH})`,
        );
      }
      seen.add(gg.id);
    }
    out.thirdPartyGateways = (tpg as ThirdPartyGatewayProfile[]).map((g) => ({ ...g }));
  }
  return out;
}

function validateAdapter(id: string, field: string): void {
  const mod = getAdapterModule(id);
  if (!mod) {
    throw new Error(
      `unknown ${field} "${id}". Registered: ${listAdapterIds().join(", ")}`,
    );
  }
  if (mod.supportsRun === false) {
    throw new Error(
      `${field} "${id}" is a probe-only stub and cannot handle turns yet`,
    );
  }
}

export function saveConfig(cfg: DaemonConfig): void {
  ensureDir();
  const tmp = CONFIG_PATH + ".tmp";
  writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  renameSync(tmp, CONFIG_PATH);
}

/**
 * Build a default config. Always writes the new `agents: [...]` shape when
 * explicit ids are provided; the legacy scalar `agentId` field is never
 * emitted by fresh `init` runs. When called with an empty list, `agents`
 * is omitted entirely so the daemon auto-discovers identities at boot.
 */
export function initDefaultConfig(
  agentIds: string | string[] | null | undefined,
  cwd: string = homedir(),
): DaemonConfig {
  const list = Array.isArray(agentIds)
    ? agentIds
    : typeof agentIds === "string" && agentIds.length > 0
      ? [agentIds]
      : [];
  const out: DaemonConfig = {
    defaultRoute: { adapter: "claude-code", cwd },
    routes: [],
    streamBlocks: true,
  };
  if (list.length > 0) out.agents = dedupe(list);
  return out;
}

export const CONFIG_FILE_PATH = CONFIG_PATH;
export const DAEMON_DIR_PATH = DAEMON_DIR;

/**
 * Make the daemon directory (`~/.botcord/daemon`) exist with mode `0700`.
 * Tolerant of the common case where it already exists. Exported so
 * user-auth/snapshot code can stay independent of `saveConfig`.
 */
export function ensureDaemonDir(): void {
  ensureDir();
}
