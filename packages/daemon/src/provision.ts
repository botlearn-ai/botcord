/**
 * Business logic triggered by control-plane frames. The channel dispatches
 * to this module with the parsed {@link ControlFrame}; we execute the
 * side effects (register agent, write credentials, load route, add/remove
 * gateway channel) and return an ack payload.
 *
 * See `docs/daemon-control-plane-plan.md` §4.3, §5.3, §8.
 */
import { existsSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
  BotCordClient,
  CONTROL_FRAME_TYPES,
  defaultCredentialsFile,
  derivePublicKey,
  loadStoredCredentials,
  writeCredentialsFile,
  type ControlAck,
  type ControlFrame,
  type ListRuntimesResult,
  type ProvisionAgentParams,
  type RevokeAgentParams,
  type RuntimeProbeResult,
  type StoredBotCordCredentials,
} from "@botcord/protocol-core";
import type { Gateway } from "./gateway/index.js";
import type {
  GatewayChannelConfig,
  GatewayRuntimeSnapshot,
} from "./gateway/index.js";
import {
  loadConfig,
  resolveConfiguredAgentIds,
  saveConfig,
  type DaemonConfig,
  type RouteRule,
  type RouteRuleMatch,
} from "./config.js";
import { BOTCORD_CHANNEL_TYPE } from "./daemon-config-map.js";
import { detectRuntimes, getAdapterModule } from "./adapters/runtimes.js";
import { log as daemonLog } from "./log.js";

/** Options accepted by {@link createProvisioner}. */
export interface ProvisionerOptions {
  /** Live gateway handle used to hot-plug channels. */
  gateway: Gateway;
  /**
   * Override for `BotCordClient.register` — tests inject a stub so they can
   * run without a real Hub.
   */
  register?: typeof BotCordClient.register;
}

/** The value a frame handler returns (minus the `id` which the channel fills in). */
type AckBody = Omit<ControlAck, "id">;

/**
 * Build a dispatcher function that routes a `ControlFrame` to the right
 * handler. Returned function signature matches
 * `ControlChannelOptions.handle`.
 */
export function createProvisioner(opts: ProvisionerOptions): (
  frame: ControlFrame,
) => Promise<AckBody> {
  const gateway = opts.gateway;
  const register = opts.register ?? BotCordClient.register;

  return async (frame: ControlFrame): Promise<AckBody> => {
    switch (frame.type) {
      case CONTROL_FRAME_TYPES.PING:
        return { ok: true, result: { pong: true, ts: Date.now() } };

      case CONTROL_FRAME_TYPES.PROVISION_AGENT: {
        const params = (frame.params ?? {}) as unknown as ProvisionAgentParams;
        const agent = await provisionAgent(params, { gateway, register });
        return {
          ok: true,
          result: {
            agentId: agent.agentId,
            hubUrl: agent.hubUrl,
            credentialsFile: agent.credentialsFile,
          },
        };
      }

      case CONTROL_FRAME_TYPES.REVOKE_AGENT: {
        const params = (frame.params ?? {}) as unknown as RevokeAgentParams;
        const res = await revokeAgent(params, { gateway });
        return { ok: true, result: res };
      }

      case CONTROL_FRAME_TYPES.LIST_AGENTS: {
        const agents = listAgentsFromGateway(gateway);
        return { ok: true, result: { agents } };
      }

      case CONTROL_FRAME_TYPES.RELOAD_CONFIG: {
        const res = await reloadConfig({ gateway });
        return { ok: true, result: res };
      }

      case CONTROL_FRAME_TYPES.SET_ROUTE: {
        const res = setRoute(frame.params ?? {});
        return { ok: true, result: res };
      }

      case CONTROL_FRAME_TYPES.LIST_RUNTIMES: {
        const snapshot = collectRuntimeSnapshot();
        return { ok: true, result: snapshot };
      }

      default:
        return {
          ok: false,
          error: { code: "unknown_type", message: `unknown control frame type "${frame.type}"` },
        };
    }
  };
}

interface ProvisionedAgent {
  agentId: string;
  hubUrl: string;
  credentialsFile: string;
}

interface ProvisionCtx {
  gateway: Gateway;
  register: typeof BotCordClient.register;
}

async function provisionAgent(
  params: ProvisionAgentParams,
  ctx: ProvisionCtx,
): Promise<ProvisionedAgent> {
  assertSafeCwd(params.cwd);

  const cfg = loadConfig();
  const credentials = await materializeCredentials(params, cfg, ctx);

  const credentialsFile = writeCredentialsFile(
    defaultCredentialsFile(credentials.agentId),
    credentials,
  );

  try {
    const updated = addAgentToConfig(cfg, credentials.agentId);
    if (updated) saveConfig(updated);
  } catch (err) {
    // Rollback the credentials file if we can't persist config — the
    // daemon should stay in sync or not at all. `addChannel` below would
    // otherwise succeed against a config that doesn't list the agent.
    try {
      unlinkSync(credentialsFile);
    } catch {
      // best-effort
    }
    throw err;
  }

  try {
    await ctx.gateway.addChannel({
      id: credentials.agentId,
      type: BOTCORD_CHANNEL_TYPE,
      accountId: credentials.agentId,
      agentId: credentials.agentId,
    });
  } catch (err) {
    // Best-effort rollback: drop the new agent from config and remove the
    // credentials file. Log loudly so operators notice the partial state.
    daemonLog.error("provision.addChannel failed, rolling back", {
      agentId: credentials.agentId,
      error: err instanceof Error ? err.message : String(err),
    });
    try {
      const revertCfg = removeAgentFromConfig(loadConfig(), credentials.agentId);
      if (revertCfg) saveConfig(revertCfg);
    } catch {
      // ignore
    }
    try {
      unlinkSync(credentialsFile);
    } catch {
      // ignore
    }
    throw err;
  }

  daemonLog.info("agent provisioned", {
    agentId: credentials.agentId,
    credentialsFile,
  });

  return {
    agentId: credentials.agentId,
    hubUrl: credentials.hubUrl,
    credentialsFile,
  };
}

async function materializeCredentials(
  params: ProvisionAgentParams,
  cfg: DaemonConfig,
  ctx: ProvisionCtx,
): Promise<StoredBotCordCredentials> {
  // Runtime is an agent property (docs/agent-runtime-property-plan.md §4.1).
  // Hub is authoritative; top-level `runtime` wins, `adapter` is a one-release
  // alias, and `credentials.runtime` is the per-agent cached copy.
  const runtime = pickRuntime(params);
  if (runtime) assertKnownRuntime(runtime);
  const cwd = params.credentials?.cwd ?? params.cwd;

  // Fast path: Hub handed us the credential envelope directly.
  if (params.credentials) {
    const c = params.credentials;
    if (!c.agentId || !c.keyId || !c.privateKey) {
      throw new Error(
        "provision_agent.credentials missing required fields (agentId, keyId, privateKey)",
      );
    }
    const derivedPub = derivePublicKey(c.privateKey);
    if (c.publicKey && c.publicKey !== derivedPub) {
      throw new Error("provision_agent.credentials publicKey does not match privateKey");
    }
    const hubUrl = c.hubUrl;
    if (!hubUrl) {
      throw new Error("provision_agent.credentials missing hubUrl");
    }
    const record: StoredBotCordCredentials = {
      version: 1,
      hubUrl,
      agentId: c.agentId,
      keyId: c.keyId,
      privateKey: c.privateKey,
      publicKey: c.publicKey ?? derivedPub,
      savedAt: new Date().toISOString(),
    };
    if (c.displayName) record.displayName = c.displayName;
    if (c.token) record.token = c.token;
    if (typeof c.tokenExpiresAt === "number") record.tokenExpiresAt = c.tokenExpiresAt;
    if (runtime) record.runtime = runtime;
    if (cwd) record.cwd = cwd;
    return record;
  }

  // Slow path: daemon registers a fresh identity against Hub. We need a
  // hubUrl — but `DaemonConfig` doesn't persist one, so fall back to a
  // sibling credentials file if any agent is already bound.
  const hubUrl = inferHubUrl(cfg);
  if (!hubUrl) {
    throw new Error(
      "provision_agent: cannot register without a known hubUrl — include `credentials.hubUrl` in the frame",
    );
  }
  const name = params.name || `agent-${Date.now()}`;
  const reg = await ctx.register(hubUrl, name, params.bio);
  const record: StoredBotCordCredentials = {
    version: 1,
    hubUrl: reg.hubUrl,
    agentId: reg.agentId,
    keyId: reg.keyId,
    privateKey: reg.privateKey,
    publicKey: reg.publicKey,
    savedAt: new Date().toISOString(),
    displayName: name,
    token: reg.token,
    tokenExpiresAt: reg.expiresAt,
  };
  if (runtime) record.runtime = runtime;
  if (cwd) record.cwd = cwd;
  return record;
}

interface RevokeResult {
  agentId: string;
  removed: boolean;
  credentialsDeleted: boolean;
}

async function revokeAgent(
  params: RevokeAgentParams,
  ctx: { gateway: Gateway },
): Promise<RevokeResult> {
  if (!params.agentId) {
    throw new Error("revoke_agent requires params.agentId");
  }
  const agentId = params.agentId;
  const deleteCreds = params.deleteCredentials !== false;

  try {
    await ctx.gateway.removeChannel(agentId, "revoked by hub");
  } catch (err) {
    daemonLog.warn("revoke.removeChannel failed", {
      agentId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  let removed = false;
  try {
    const cfg = loadConfig();
    const next = removeAgentFromConfig(cfg, agentId);
    if (next) {
      saveConfig(next);
      removed = true;
    }
  } catch (err) {
    daemonLog.warn("revoke.saveConfig failed", {
      agentId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  let credentialsDeleted = false;
  if (deleteCreds) {
    const file = defaultCredentialsFile(agentId);
    try {
      if (existsSync(file)) {
        unlinkSync(file);
        credentialsDeleted = true;
      }
    } catch (err) {
      daemonLog.warn("revoke.unlink failed", {
        agentId,
        file,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  daemonLog.info("agent revoked", { agentId, removed, credentialsDeleted });
  return { agentId, removed, credentialsDeleted };
}

/** Reject paths outside the operator's home directory (plan §8.3). */
function assertSafeCwd(cwd: string | undefined): void {
  if (!cwd) return;
  const home = homedir();
  const abs = path.resolve(cwd);
  const rel = path.relative(home, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`provision_agent.cwd "${cwd}" is outside the user home directory`);
  }
}

/**
 * Append `agentId` to the daemon config if not already present. Returns a
 * new config object or `null` if nothing changed (so callers can skip the
 * disk write).
 */
export function addAgentToConfig(cfg: DaemonConfig, agentId: string): DaemonConfig | null {
  const list = Array.isArray(cfg.agents) ? cfg.agents.slice() : [];
  if (cfg.agentId && !list.includes(cfg.agentId)) list.push(cfg.agentId);
  if (list.includes(agentId)) return null;
  list.push(agentId);
  const next: DaemonConfig = { ...cfg, agents: list };
  // Once `agents` exists explicitly, the legacy scalar becomes redundant.
  delete next.agentId;
  return next;
}

/** Inverse of {@link addAgentToConfig}. Returns `null` on no-op. */
export function removeAgentFromConfig(
  cfg: DaemonConfig,
  agentId: string,
): DaemonConfig | null {
  const list = Array.isArray(cfg.agents) ? cfg.agents.slice() : [];
  if (cfg.agentId && !list.includes(cfg.agentId)) list.push(cfg.agentId);
  const before = list.length;
  const filtered = list.filter((a) => a !== agentId);
  const legacyMatched = cfg.agentId === agentId;
  if (filtered.length === before && !legacyMatched) return null;
  const next: DaemonConfig = { ...cfg, agents: filtered };
  if (legacyMatched) delete next.agentId;
  return next;
}

// ---------------------------------------------------------------------------
// runtime-discovery snapshot (plan §8.5)
// ---------------------------------------------------------------------------

/**
 * Probe every registered adapter and shape the result as the wire-level
 * {@link ListRuntimesResult} — used by both the `list_runtimes` ack path and
 * the daemon-side first-connect `runtime_snapshot` push in `daemon.ts`.
 *
 * Kept pure: the only side effects are `detectRuntimes()` itself (which the
 * gateway already isolates from throwing) and reading the wall clock.
 */
export function collectRuntimeSnapshot(): ListRuntimesResult {
  const entries = detectRuntimes();
  const runtimes: RuntimeProbeResult[] = entries.map((entry) => {
    const record: RuntimeProbeResult = {
      id: entry.id,
      available: entry.result.available,
    };
    // Only attach optional fields when present so the wire frame doesn't
    // carry explicit `undefined`s — mirrors the credential-materialization
    // style used above.
    if (entry.result.version) record.version = entry.result.version;
    if (entry.result.path) record.path = entry.result.path;
    // Gateway's probe surface doesn't expose an `error` string today — it
    // already swallows throws into `{available: false}`. We leave the wire
    // field blank in that case and let callers treat `!available` as reason
    // enough; filling a synthetic message would be misleading.
    return record;
  });
  return { runtimes, probedAt: Date.now() };
}

// ---------------------------------------------------------------------------
// reload_config / list_agents / set_route handlers (P3)
// ---------------------------------------------------------------------------

interface ReloadResult {
  reloaded: true;
  added: string[];
  removed: string[];
}

/**
 * Re-read `config.json` and reconcile the running gateway against it. New
 * agents in config but not in gateway snapshot → `addChannel`; agents in
 * gateway but no longer in config → `removeChannel`. The agent's
 * credentials must already exist on disk; we don't re-register identities
 * here (that's `provision_agent`'s job).
 */
export async function reloadConfig(ctx: { gateway: Gateway }): Promise<ReloadResult> {
  const cfg = loadConfig();
  const desired = new Set(resolveConfiguredAgentIds(cfg) ?? []);
  const current = new Set(Object.keys(ctx.gateway.snapshot().channels));

  const added: string[] = [];
  const removed: string[] = [];

  for (const id of desired) {
    if (current.has(id)) continue;
    const channelCfg: GatewayChannelConfig = {
      id,
      type: BOTCORD_CHANNEL_TYPE,
      accountId: id,
      agentId: id,
    };
    try {
      await ctx.gateway.addChannel(channelCfg);
      added.push(id);
    } catch (err) {
      daemonLog.warn("reload_config.addChannel failed", {
        agentId: id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  for (const id of current) {
    if (desired.has(id)) continue;
    try {
      await ctx.gateway.removeChannel(id, "reload_config");
      removed.push(id);
    } catch (err) {
      daemonLog.warn("reload_config.removeChannel failed", {
        agentId: id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  daemonLog.info("config reloaded", { added, removed });
  return { reloaded: true, added, removed };
}

/**
 * Per-agent entry returned by `list_agents`. Shape follows
 * `docs/daemon-control-plane-api-contract.md` §3.2 — `{id, name, online}`.
 * `status` and `lastMessageAt` are extra daemon-only fields the dashboard
 * may ignore; kept so future contract revisions can promote them without
 * breaking the wire.
 */
export interface AgentListEntry {
  id: string;
  /** Display name from credentials, when known. Falls back to the agent id. */
  name: string;
  /** True when the gateway channel is currently running + connected. */
  online: boolean;
  status: "running" | "stopped" | "unknown";
  lastMessageAt?: number;
}

function listAgentsFromGateway(gateway: Gateway): AgentListEntry[] {
  const snap: GatewayRuntimeSnapshot = gateway.snapshot();
  // Include any configured agents that the gateway may not have a status for
  // yet (e.g. initial boot before first reconcile).
  let configuredIds: string[] = [];
  try {
    configuredIds = resolveConfiguredAgentIds(loadConfig()) ?? [];
  } catch {
    configuredIds = [];
  }
  const ids = new Set<string>([...Object.keys(snap.channels), ...configuredIds]);
  const out: AgentListEntry[] = [];
  for (const id of ids) {
    const ch = snap.channels[id];
    let name = id;
    try {
      const file = defaultCredentialsFile(id);
      if (existsSync(file)) {
        const c = loadStoredCredentials(file);
        if (c.displayName) name = c.displayName;
      }
    } catch {
      // ignore — fall back to the id
    }
    const online = !!(ch && ch.running && ch.connected !== false);
    const entry: AgentListEntry = {
      id,
      name,
      online,
      status: ch ? (ch.running ? "running" : "stopped") : "unknown",
    };
    if (ch?.lastStartAt) entry.lastMessageAt = ch.lastStartAt;
    out.push(entry);
  }
  return out;
}

interface SetRouteResult {
  ok: true;
  agentId: string;
  routeIndex: number;
  inserted: boolean;
}

interface SetRouteParams {
  agentId?: string;
  /**
   * Contract shape (`docs/daemon-control-plane-api-contract.md` §3.2):
   * `{pattern, agentId}`. `pattern` is treated as a conversation-id prefix
   * (`rm_oc_*` etc.). When `route` is omitted, we synthesize a sensible
   * default route record using the daemon's existing default adapter+cwd.
   */
  pattern?: string;
  /**
   * Daemon-richer shape (back-compat). When provided, takes precedence
   * over `pattern` since it can express more than just a prefix.
   */
  route?: {
    adapter?: string;
    cwd?: string;
    extraArgs?: string[];
    match?: RouteRuleMatch;
  };
}

/**
 * Persist a route in `config.json` for the given agent. If a route already
 * matches `agentId` exactly (single-key match), it is replaced; otherwise a
 * new entry is appended. `match.accountId` is forced to `agentId` so the
 * route is always agent-scoped. The change is applied at next
 * `reload_config` — it does not mutate the live router immediately.
 *
 * Accepts the contract's `{pattern, agentId}` shape (treats `pattern` as a
 * conversation-id prefix) AND the richer `{agentId, route: {...}}` shape
 * for daemon-side callers that need to set adapter/cwd explicitly.
 */
export function setRoute(params: unknown): SetRouteResult {
  const p = (params ?? {}) as SetRouteParams;
  const agentId = p.agentId;
  if (!agentId || typeof agentId !== "string") {
    throw new Error("set_route requires params.agentId");
  }
  const route = p.route;
  if (!route && (!p.pattern || typeof p.pattern !== "string")) {
    throw new Error("set_route requires either params.route or params.pattern");
  }

  // Defaults used when only `pattern` is supplied.
  const cfg = loadConfig();
  const adapter = route?.adapter ?? cfg.defaultRoute.adapter;
  if (!getAdapterModule(adapter)) {
    throw new Error(`set_route: unknown adapter "${adapter}"`);
  }
  const cwd = route?.cwd ?? cfg.defaultRoute.cwd;
  if (!cwd || typeof cwd !== "string") {
    throw new Error("set_route: route.cwd is required");
  }
  assertSafeCwd(cwd);

  // Build the canonical match — always pin accountId so the route can't
  // accidentally bleed across agents.
  const incomingMatch = (route?.match ?? {}) as RouteRuleMatch;
  const match: RouteRuleMatch = { ...incomingMatch, accountId: agentId };
  if (p.pattern && typeof p.pattern === "string" && !match.conversationPrefix) {
    match.conversationPrefix = p.pattern;
  }

  const newRule: RouteRule = {
    match,
    adapter,
    cwd,
    ...(Array.isArray(route?.extraArgs) ? { extraArgs: route!.extraArgs!.slice() } : {}),
  };

  const routes = Array.isArray(cfg.routes) ? cfg.routes.slice() : [];
  // Replace an existing matching rule. We use the canonical signature
  // (accountId + conversationPrefix or accountId-only) so successive
  // `set_route` calls for the same agent+pattern overwrite in place.
  const sameSignature = (m: RouteRuleMatch | undefined): boolean => {
    if (!m) return false;
    if (m.accountId !== agentId) return false;
    const incomingPrefix = match.conversationPrefix ?? null;
    const existingPrefix = m.conversationPrefix ?? m.roomPrefix ?? null;
    if (incomingPrefix !== existingPrefix) return false;
    if (incomingPrefix === null && hasNonAccountSelector(m)) return false;
    return true;
  };
  const existingIdx = routes.findIndex((r) => sameSignature(r.match));

  let inserted = false;
  let routeIndex: number;
  if (existingIdx >= 0) {
    routes[existingIdx] = newRule;
    routeIndex = existingIdx;
  } else {
    routes.push(newRule);
    routeIndex = routes.length - 1;
    inserted = true;
  }

  const next: DaemonConfig = { ...cfg, routes };
  saveConfig(next);
  daemonLog.info("route set", { agentId, routeIndex, inserted });
  return { ok: true, agentId, routeIndex, inserted };
}

function hasNonAccountSelector(m: RouteRuleMatch | undefined): boolean {
  if (!m) return false;
  return !!(
    m.channel ||
    m.conversationId ||
    m.conversationPrefix ||
    m.conversationKind ||
    m.senderId ||
    m.roomId ||
    m.roomPrefix ||
    typeof m.mentioned === "boolean"
  );
}

/**
 * Resolve the runtime id the frame asks for. Prefers the canonical
 * `runtime` field; falls back to the deprecated `adapter` alias and finally
 * to `credentials.runtime` for Hub builds that ship the envelope-only form.
 */
function pickRuntime(params: ProvisionAgentParams): string | undefined {
  const candidates = [params.runtime, params.adapter, params.credentials?.runtime];
  for (const c of candidates) {
    if (typeof c === "string" && c.length > 0) return c;
  }
  return undefined;
}

function assertKnownRuntime(runtime: string): void {
  const mod = getAdapterModule(runtime);
  if (!mod) {
    throw new Error(`provision_agent: unknown runtime "${runtime}"`);
  }
}

/**
 * Pull a hubUrl out of an existing credentials file, if the daemon is
 * already bound to at least one agent. Used as a fallback when
 * `provision_agent` doesn't carry an explicit `credentials.hubUrl`.
 */
function inferHubUrl(cfg: DaemonConfig): string | null {
  const ids = resolveConfiguredAgentIds(cfg) ?? [];
  for (const id of ids) {
    const file = defaultCredentialsFile(id);
    try {
      if (!existsSync(file)) continue;
      const creds = loadStoredCredentials(file);
      if (creds.hubUrl) return creds.hubUrl;
    } catch {
      // skip
    }
  }
  return null;
}
