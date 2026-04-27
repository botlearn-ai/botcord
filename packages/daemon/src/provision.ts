/**
 * Business logic triggered by control-plane frames. The channel dispatches
 * to this module with the parsed {@link ControlFrame}; we execute the
 * side effects (register agent, write credentials, load route, add/remove
 * gateway channel) and return an ack payload.
 */
import { existsSync, rmSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
  BotCordClient,
  CONTROL_FRAME_TYPES,
  defaultCredentialsFile,
  derivePublicKey,
  loadStoredCredentials,
  writeCredentialsFile,
  type AgentIdentitySnapshot,
  type ControlAck,
  type ControlFrame,
  type HelloParams,
  type ListRuntimesResult,
  type ProvisionAgentParams,
  type RevokeAgentParams,
  type RevokeAgentResult,
  type RuntimeProbeResult,
  type StoredBotCordCredentials,
  type UpdateAgentParams,
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
import { BOTCORD_CHANNEL_TYPE, buildManagedRoutes } from "./daemon-config-map.js";
import {
  agentHomeDir,
  agentStateDir,
  agentWorkspaceDir,
  applyAgentIdentity,
  ensureAgentWorkspace,
} from "./agent-workspace.js";
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
    daemonLog.debug("provision.dispatch", { type: frame.type, id: frame.id });
    switch (frame.type) {
      case CONTROL_FRAME_TYPES.PING:
        return { ok: true, result: { pong: true, ts: Date.now() } };

      case CONTROL_FRAME_TYPES.HELLO: {
        const params = (frame.params ?? {}) as unknown as HelloParams;
        const result = applyHelloIdentitySnapshot(params.agents);
        daemonLog.debug("hello: identity snapshot applied", {
          frameId: frame.id,
          received: params.agents?.length ?? 0,
          updated: result.updated,
          skipped: result.skipped,
        });
        return { ok: true, result };
      }

      case CONTROL_FRAME_TYPES.UPDATE_AGENT: {
        const params = (frame.params ?? {}) as unknown as UpdateAgentParams;
        if (!params.agentId) {
          return {
            ok: false,
            error: { code: "bad_params", message: "update_agent requires params.agentId" },
          };
        }
        const result = applyAgentIdentity(params.agentId, {
          displayName: params.displayName,
          bio: params.bio,
        });
        daemonLog.info("update_agent applied", {
          agentId: params.agentId,
          changed: result.changed,
          skipped: result.skipped ?? null,
        });
        return { ok: true, result };
      }

      case CONTROL_FRAME_TYPES.PROVISION_AGENT: {
        const params = (frame.params ?? {}) as unknown as ProvisionAgentParams;
        daemonLog.info("provision_agent: start", {
          frameId: frame.id,
          hasCredentials: !!params.credentials,
          runtime: pickRuntime(params) ?? null,
          name: params.name ?? null,
        });
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
        daemonLog.info("revoke_agent: start", {
          frameId: frame.id,
          agentId: params.agentId,
          deleteCredentials: params.deleteCredentials !== false,
        });
        const res = await revokeAgent(params, { gateway });
        return { ok: true, result: res };
      }

      case CONTROL_FRAME_TYPES.LIST_AGENTS: {
        const agents = listAgentsFromGateway(gateway);
        daemonLog.debug("list_agents", { count: agents.length });
        return { ok: true, result: { agents } };
      }

      case CONTROL_FRAME_TYPES.RELOAD_CONFIG: {
        daemonLog.info("reload_config: start", { frameId: frame.id });
        const res = await reloadConfig({ gateway });
        return { ok: true, result: res };
      }

      case CONTROL_FRAME_TYPES.SET_ROUTE: {
        daemonLog.info("set_route: start", { frameId: frame.id });
        const res = setRoute(frame.params ?? {});
        return { ok: true, result: res };
      }

      case CONTROL_FRAME_TYPES.LIST_RUNTIMES: {
        const snapshot = collectRuntimeSnapshot();
        daemonLog.debug("list_runtimes", { count: snapshot.runtimes.length });
        return { ok: true, result: snapshot };
      }

      default:
        daemonLog.warn("provision.dispatch: unknown frame type", {
          type: frame.type,
          id: frame.id,
        });
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
  // Validate both caller-supplied cwd sources up front. Previously only
  // `params.cwd` was checked, so `params.credentials.cwd` could smuggle an
  // arbitrary path (e.g. `/etc`) into the credentials file; plan §7 closes
  // that hole by moving the check to the union of both.
  const explicitCwd = params.credentials?.cwd ?? params.cwd;
  assertSafeCwd(explicitCwd);

  const cfg = loadConfig();
  const credentials = await materializeCredentials(params, cfg, ctx, explicitCwd);
  daemonLog.debug("provision: credentials materialized", {
    agentId: credentials.agentId,
    hubUrl: credentials.hubUrl,
    runtime: credentials.runtime ?? null,
    source: params.credentials ? "hub-supplied" : "registered",
  });

  const credentialsFile = writeCredentialsFile(
    defaultCredentialsFile(credentials.agentId),
    credentials,
  );

  // Seed the per-agent workspace directory. On failure, unlink the fresh
  // credentials file but do NOT `rm -rf` the agent dir — partial contents
  // may belong to a pre-existing workspace we must not touch.
  try {
    ensureAgentWorkspace(credentials.agentId, {
      displayName: credentials.displayName,
      bio: params.bio,
      runtime: credentials.runtime,
      keyId: credentials.keyId,
      savedAt: credentials.savedAt,
    });
  } catch (err) {
    try {
      unlinkSync(credentialsFile);
    } catch {
      // best-effort
    }
    throw err;
  }

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

  // Hot-add the synthesized per-agent managed route so the next turn picks
  // the agent's runtime + workspace cwd without waiting for reload_config.
  try {
    ctx.gateway.upsertManagedRoute(credentials.agentId, {
      match: { accountId: credentials.agentId },
      runtime: credentials.runtime ?? cfg.defaultRoute.adapter,
      cwd: credentials.cwd ?? agentWorkspaceDir(credentials.agentId),
    });
  } catch (err) {
    // Rollback the channel + config + credentials on managed-route failure
    // (shouldn't happen — pure map op — but keeps the invariant tight).
    daemonLog.error("provision.upsertManagedRoute failed, rolling back", {
      agentId: credentials.agentId,
      error: err instanceof Error ? err.message : String(err),
    });
    try {
      await ctx.gateway.removeChannel(credentials.agentId, "provision rollback");
    } catch {
      // ignore
    }
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
  explicitCwd: string | undefined,
): Promise<StoredBotCordCredentials> {
  // Runtime is an agent property. Hub is authoritative; top-level `runtime`
  // wins, `adapter` is a one-release alias, and `credentials.runtime` is the
  // per-agent cached copy.
  const runtime = pickRuntime(params);
  if (runtime) assertKnownRuntime(runtime);

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
    const cwd = explicitCwd ?? agentWorkspaceDir(c.agentId);
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
    record.cwd = cwd;
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
  const cwd = explicitCwd ?? agentWorkspaceDir(reg.agentId);
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
  record.cwd = cwd;
  return record;
}

async function revokeAgent(
  params: RevokeAgentParams,
  ctx: { gateway: Gateway },
): Promise<RevokeAgentResult> {
  if (!params.agentId) {
    throw new Error("revoke_agent requires params.agentId");
  }
  const agentId = params.agentId;
  const deleteCreds = params.deleteCredentials !== false;
  // `deleteState` defaults to whatever `deleteCredentials` resolves to —
  // vanilla revoke wipes runtime state, but explicit `deleteCredentials:false`
  // (keep-creds) also implies keep-state unless the caller says otherwise.
  const deleteState = params.deleteState ?? deleteCreds;
  // Workspace is precious (user-authored memory/notes); require explicit opt-in.
  const deleteWorkspace = params.deleteWorkspace === true;

  // In-memory gateway ops run first so any in-flight turn is aborted before
  // disk state changes. Both run unconditionally — the channel is revoked
  // regardless of whether disk state survives, and the synthesized managed
  // route is now dangling.
  try {
    await ctx.gateway.removeChannel(agentId, "revoked by hub");
  } catch (err) {
    daemonLog.warn("revoke.removeChannel failed", {
      agentId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  try {
    ctx.gateway.removeManagedRoute(agentId);
  } catch (err) {
    daemonLog.warn("revoke.removeManagedRoute failed", {
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

  // Disk steps are independent and best-effort: a failure at one step logs a
  // warning but does not prevent the next (matches `deleteCredentials`).
  let stateDeleted = false;
  let workspaceDeleted = false;
  if (deleteWorkspace) {
    // Workspace deletion subsumes state — remove the whole agent home.
    const home = agentHomeDir(agentId);
    try {
      if (existsSync(home)) {
        rmSync(home, { recursive: true, force: true });
        workspaceDeleted = true;
        stateDeleted = true;
      }
    } catch (err) {
      daemonLog.warn("revoke.rmWorkspace failed", {
        agentId,
        path: home,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  } else if (deleteState) {
    const state = agentStateDir(agentId);
    try {
      if (existsSync(state)) {
        rmSync(state, { recursive: true, force: true });
        stateDeleted = true;
      }
    } catch (err) {
      daemonLog.warn("revoke.rmState failed", {
        agentId,
        path: state,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  daemonLog.info("agent revoked", {
    agentId,
    removed,
    credentialsDeleted,
    stateDeleted,
    workspaceDeleted,
  });
  return { agentId, removed, credentialsDeleted, stateDeleted, workspaceDeleted };
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
// hello agents snapshot (lightweight identity sync)
// ---------------------------------------------------------------------------

interface HelloIdentityResult {
  updated: number;
  skipped: number;
}

/**
 * Reconcile every agent identity carried by the `hello.agents` snapshot
 * against the on-disk `identity.md`. Best-effort: a malformed entry or a
 * file-system error for one agent never aborts the rest.
 *
 * Identity-snapshot semantics intentionally only touch the metadata
 * line + Bio body — Role/Boundaries paragraphs the user authored locally
 * are preserved (see `applyAgentIdentity`). Missing identity.md files
 * (agent provisioned on a different daemon, or workspace cleared) are
 * silently skipped.
 */
export function applyHelloIdentitySnapshot(
  snapshot: AgentIdentitySnapshot[] | undefined,
): HelloIdentityResult {
  const out: HelloIdentityResult = { updated: 0, skipped: 0 };
  if (!Array.isArray(snapshot)) return out;
  for (const entry of snapshot) {
    if (!entry || typeof entry.agentId !== "string") {
      out.skipped += 1;
      continue;
    }
    try {
      const result = applyAgentIdentity(entry.agentId, {
        displayName: entry.displayName,
        bio: entry.bio,
      });
      if (result.changed) out.updated += 1;
      else out.skipped += 1;
    } catch (err) {
      out.skipped += 1;
      daemonLog.warn("hello.identity apply failed", {
        agentId: entry.agentId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return out;
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

  // Re-synthesize managed routes so `set_route` + `reload_config` actually
  // applies at runtime (plan §10.5). User-authored `cfg.routes[]` lives in a
  // different bucket and is unaffected.
  try {
    const freshCfg = loadConfig();
    const freshAgents = resolveConfiguredAgentIds(freshCfg) ?? [];
    const agentRuntimes = readAgentRuntimesFromCredentials(freshAgents);
    const freshDefault = {
      runtime: freshCfg.defaultRoute.adapter,
      cwd: freshCfg.defaultRoute.cwd,
    };
    const managed = buildManagedRoutes(freshAgents, agentRuntimes, freshDefault);
    ctx.gateway.replaceManagedRoutes(managed);
  } catch (err) {
    daemonLog.warn("reload_config.replaceManagedRoutes failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  daemonLog.info("config reloaded", { added, removed });
  return { reloaded: true, added, removed };
}

/**
 * Read cached `runtime`/`cwd` from each agent's credentials file. Missing
 * files or malformed entries are skipped silently — callers fall back to
 * the daemon's `defaultRoute` for those agents.
 */
function readAgentRuntimesFromCredentials(
  agentIds: string[],
): Record<string, { runtime?: string; cwd?: string }> {
  const out: Record<string, { runtime?: string; cwd?: string }> = {};
  for (const id of agentIds) {
    const file = defaultCredentialsFile(id);
    try {
      if (!existsSync(file)) continue;
      const creds = loadStoredCredentials(file);
      const entry: { runtime?: string; cwd?: string } = {};
      if (creds.runtime) entry.runtime = creds.runtime;
      if (creds.cwd) entry.cwd = creds.cwd;
      if (entry.runtime || entry.cwd) out[id] = entry;
    } catch {
      // best-effort — skip agents with unreadable credentials
    }
  }
  return out;
}

/**
 * Per-agent entry returned by `list_agents`. Wire shape: `{id, name, online}`.
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
   * Contract shape `{pattern, agentId}`. `pattern` is treated as a
   * conversation-id prefix (`rm_oc_*` etc.). When `route` is omitted, we
   * synthesize a sensible default route record using the daemon's existing
   * default adapter+cwd.
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
