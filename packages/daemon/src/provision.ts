/**
 * Business logic triggered by control-plane frames. The channel dispatches
 * to this module with the parsed {@link ControlFrame}; we execute the
 * side effects (register agent, write credentials, load route, add/remove
 * gateway channel) and return an ack payload.
 */
import { existsSync, readFileSync, rmSync, unlinkSync } from "node:fs";
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
import type { PolicyResolverLike } from "./gateway/policy-resolver.js";
import type { PolicyUpdatedParams } from "@botcord/protocol-core";
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
import {
  BOTCORD_CHANNEL_TYPE,
  buildManagedRoutes,
  prepareGatewayProfile,
} from "./daemon-config-map.js";
import {
  agentHomeDir,
  agentStateDir,
  agentWorkspaceDir,
  applyAgentIdentity,
  ensureAgentWorkspace,
} from "./agent-workspace.js";
import { detectRuntimes, getAdapterModule } from "./adapters/runtimes.js";
import { log as daemonLog } from "./log.js";
import { discoverAgentCredentials } from "./agent-discovery.js";

/** Options accepted by {@link createProvisioner}. */
export interface ProvisionerOptions {
  /** Live gateway handle used to hot-plug channels. */
  gateway: Gateway;
  /**
   * Override for `BotCordClient.register` — tests inject a stub so they can
   * run without a real Hub.
   */
  register?: typeof BotCordClient.register;
  /**
   * Optional policy-resolver handle (PR3). When present, the
   * `policy_updated` control frame routes through it: cache is invalidated
   * for the (agent, room?) pair, and any embedded `policy` payload is
   * applied directly so the next inbound sees the fresh policy without an
   * extra round-trip.
   */
  policyResolver?: PolicyResolverLike;
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
  const policyResolver = opts.policyResolver;

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
        // Seed the policy resolver from the optional `defaultAttention` /
        // `attentionKeywords` fields (PR3, control-frame.ts). Hub builds that
        // don't yet emit these stay backwards-compatible — the resolver just
        // falls back to `mode=always` until a `policy_updated` frame arrives.
        if (policyResolver && params.defaultAttention) {
          policyResolver.put(agent.agentId, null, {
            mode: params.defaultAttention,
            keywords: Array.isArray(params.attentionKeywords)
              ? params.attentionKeywords.slice()
              : [],
          });
        }
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

      case CONTROL_FRAME_TYPES.POLICY_UPDATED: {
        const params = (frame.params ?? {}) as unknown as PolicyUpdatedParams;
        const agentId = params.agent_id;
        if (typeof agentId !== "string" || !agentId) {
          return {
            ok: false,
            error: { code: "bad_params", message: "policy_updated requires agent_id" },
          };
        }
        if (!policyResolver) {
          // No resolver wired — quietly succeed; the daemon may be running
          // without the gateway-level attention gate (e.g. legacy boot path).
          daemonLog.debug("policy_updated: no resolver — noop", { agentId });
          return { ok: true, result: { agent_id: agentId, applied: false } };
        }
        const roomId = typeof params.room_id === "string" ? params.room_id : undefined;
        if (params.policy) {
          // Embedded policy payload — install directly to avoid a refetch.
          policyResolver.put(agentId, roomId ?? null, {
            mode: params.policy.mode,
            keywords: Array.isArray(params.policy.keywords)
              ? params.policy.keywords.slice()
              : [],
            ...(typeof params.policy.muted_until === "number"
              ? { muted_until: params.policy.muted_until }
              : {}),
          });
        } else {
          policyResolver.invalidate(agentId, roomId);
        }
        daemonLog.info("policy_updated: applied", {
          agentId,
          roomId: roomId ?? null,
          embedded: !!params.policy,
        });
        return {
          ok: true,
          result: { agent_id: agentId, applied: true, embedded: !!params.policy },
        };
      }

      case CONTROL_FRAME_TYPES.LIST_RUNTIMES: {
        // Async path so the openclaw-acp endpoints get probed inline; gateway
        // / WS errors are swallowed inside `collectRuntimeSnapshotAsync`.
        let cfgForProbe: { openclawGateways?: any[] } | undefined;
        try {
          cfgForProbe = loadConfig();
        } catch {
          cfgForProbe = undefined;
        }
        const snapshot = await collectRuntimeSnapshotAsync({ cfg: cfgForProbe });
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

const openclawProvisionLocks = new Map<string, Promise<unknown>>();

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

  const openclawSel = pickOpenclawSelection(params);
  if (openclawSel.gateway && openclawSel.agent) {
    return withOpenclawProvisionLock(openclawSel.gateway, openclawSel.agent, async () => {
      const existing = findCredentialsByOpenclaw(openclawSel.gateway!, openclawSel.agent!);
      if (existing) {
        daemonLog.info("provision_agent: openclaw binding already exists", {
          gateway: openclawSel.gateway,
          openclawAgent: openclawSel.agent,
          agentId: existing.agentId,
        });
        return installExistingOpenclawBinding(existing.agentId, ctx);
      }
      const cfg = loadConfig();
      const credentials = await materializeCredentials(params, cfg, ctx, explicitCwd);
      return installLocalAgent(credentials, {
        ...ctx,
        cfg,
        bio: params.bio,
        source: params.credentials ? "hub-supplied" : "registered",
      });
    });
  }

  const cfg = loadConfig();
  const credentials = await materializeCredentials(params, cfg, ctx, explicitCwd);
  return installLocalAgent(credentials, {
    ...ctx,
    cfg,
    bio: params.bio,
    source: params.credentials ? "hub-supplied" : "registered",
  });
}

async function installLocalAgent(
  credentials: StoredBotCordCredentials,
  ctx: ProvisionCtx & {
    cfg: DaemonConfig;
    bio?: string;
    source: "hub-supplied" | "registered" | "adopted-openclaw";
  },
): Promise<ProvisionedAgent> {
  const cfg = ctx.cfg;
  daemonLog.debug("provision: credentials materialized", {
    agentId: credentials.agentId,
    hubUrl: credentials.hubUrl,
    runtime: credentials.runtime ?? null,
    source: ctx.source,
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
      bio: ctx.bio,
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
    upsertManagedRouteForCredentials(credentials, cfg, ctx.gateway);
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

function upsertManagedRouteForCredentials(
  credentials: StoredBotCordCredentials,
  cfg: DaemonConfig,
  gateway: Gateway,
): void {
  const synthRoute: import("./gateway/index.js").GatewayRoute = {
    match: { accountId: credentials.agentId },
    runtime: credentials.runtime ?? cfg.defaultRoute.adapter,
    cwd: credentials.cwd ?? agentWorkspaceDir(credentials.agentId),
  };
  if (synthRoute.runtime === "openclaw-acp") {
    const profile = (cfg.openclawGateways ?? []).find(
      (g) => g.name === credentials.openclawGateway,
    );
    if (profile) {
      const prepared = prepareGatewayProfile(profile);
      synthRoute.gateway = {
        name: prepared.name,
        url: prepared.url,
        ...(prepared.resolvedToken ? { token: prepared.resolvedToken } : {}),
        ...(credentials.openclawAgent
          ? { openclawAgent: credentials.openclawAgent }
          : prepared.defaultAgent
            ? { openclawAgent: prepared.defaultAgent }
            : {}),
      };
    }
  }
  gateway.upsertManagedRoute(credentials.agentId, synthRoute);
}

async function installExistingOpenclawBinding(
  agentId: string,
  ctx: ProvisionCtx,
): Promise<ProvisionedAgent> {
  const credentialsFile = defaultCredentialsFile(agentId);
  const credentials = loadStoredCredentials(credentialsFile);
  const cfg = loadConfig();
  const updated = addAgentToConfig(cfg, credentials.agentId);
  if (updated) saveConfig(updated);
  const snap = ctx.gateway.snapshot();
  if (!snap.channels[credentials.agentId]) {
    await ctx.gateway.addChannel({
      id: credentials.agentId,
      type: BOTCORD_CHANNEL_TYPE,
      accountId: credentials.agentId,
      agentId: credentials.agentId,
    });
  }
  upsertManagedRouteForCredentials(credentials, cfg, ctx.gateway);
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
    const openclawSel = pickOpenclawSelection(params);
    if (openclawSel.gateway) record.openclawGateway = openclawSel.gateway;
    if (openclawSel.agent) record.openclawAgent = openclawSel.agent;
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
  const openclawSel = pickOpenclawSelection(params);
  if (openclawSel.gateway) record.openclawGateway = openclawSel.gateway;
  if (openclawSel.agent) record.openclawAgent = openclawSel.agent;
  return record;
}

/**
 * Resolve OpenClaw routing selection from a `provision_agent` frame. Top-level
 * `params.openclaw` (nested) wins over the flat `credentials.openclaw*` mirror.
 * Returning `{}` is fine — only meaningful when the agent's runtime is
 * `openclaw-acp`, and `buildManagedRoutes` falls back to defaultRoute.gateway
 * when both are missing.
 */
function pickOpenclawSelection(
  params: ProvisionAgentParams,
): { gateway?: string; agent?: string } {
  const out: { gateway?: string; agent?: string } = {};
  const top = params.openclaw;
  if (top && typeof top.gateway === "string" && top.gateway.length > 0) {
    out.gateway = top.gateway;
    if (typeof top.agent === "string" && top.agent.length > 0) out.agent = top.agent;
    return out;
  }
  const flat = params.credentials;
  if (flat) {
    if (typeof flat.openclawGateway === "string" && flat.openclawGateway.length > 0) {
      out.gateway = flat.openclawGateway;
    }
    if (typeof flat.openclawAgent === "string" && flat.openclawAgent.length > 0) {
      out.agent = flat.openclawAgent;
    }
  }
  return out;
}

async function withOpenclawProvisionLock<T>(
  gateway: string,
  agent: string,
  fn: () => Promise<T>,
): Promise<T> {
  const key = `${gateway}\0${agent}`;
  const prev = openclawProvisionLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chain = prev.then(() => current);
  openclawProvisionLocks.set(key, chain);
  await prev.catch(() => undefined);
  try {
    return await fn();
  } finally {
    release();
    if (openclawProvisionLocks.get(key) === chain) {
      openclawProvisionLocks.delete(key);
    }
  }
}

function findCredentialsByOpenclaw(
  gateway: string,
  openclawAgent: string,
): { agentId: string; credentialsFile: string } | null {
  const discovered = discoverAgentCredentials({
    credentialsDir: path.join(homedir(), ".botcord", "credentials"),
  });
  for (const a of discovered.agents) {
    if (a.openclawGateway === gateway && a.openclawAgent === openclawAgent) {
      return { agentId: a.agentId, credentialsFile: a.credentialsFile };
    }
  }
  return null;
}

export interface AdoptDiscoveredOpenclawAgentsResult {
  adopted: string[];
  skipped: Array<{ gateway: string; openclawAgent?: string; reason: string }>;
  failed: Array<{ gateway: string; openclawAgent?: string; error: string }>;
}

export async function adoptDiscoveredOpenclawAgents(ctx: {
  gateway: Gateway;
  register?: typeof BotCordClient.register;
  cfg?: DaemonConfig;
  timeoutMs?: number;
  probe?: WsEndpointProbeFn;
}): Promise<AdoptDiscoveredOpenclawAgentsResult> {
  const register = ctx.register ?? BotCordClient.register;
  const cfg = ctx.cfg ?? loadConfig();
  const result: AdoptDiscoveredOpenclawAgentsResult = {
    adopted: [],
    skipped: [],
    failed: [],
  };
  for (const gw of cfg.openclawGateways ?? []) {
    let probeResult: Awaited<ReturnType<typeof probeOpenclawAgents>>;
    try {
      probeResult = await probeOpenclawAgents(gw, {
        timeoutMs: ctx.timeoutMs,
        probe: ctx.probe,
      });
    } catch (err) {
      result.failed.push({
        gateway: gw.name,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    if (!probeResult.ok) {
      result.skipped.push({
        gateway: gw.name,
        reason: probeResult.error ?? "gateway_unreachable",
      });
      continue;
    }
    for (const oc of probeResult.agents ?? []) {
      await withOpenclawProvisionLock(gw.name, oc.id, async () => {
        const existing = findCredentialsByOpenclaw(gw.name, oc.id);
        if (existing) {
          result.skipped.push({
            gateway: gw.name,
            openclawAgent: oc.id,
            reason: "already_bound",
          });
          return;
        }
        const freshCfg = loadConfig();
        if (!inferHubUrl(freshCfg)) {
          result.skipped.push({
            gateway: gw.name,
            openclawAgent: oc.id,
            reason: "missing_hub_url",
          });
          daemonLog.warn("openclaw adopt skipped: no known hubUrl", {
            gateway: gw.name,
            openclawAgent: oc.id,
          });
          return;
        }
        try {
          const name = resolveOpenclawIdentityName(oc.id, oc.workspace) ?? oc.name ?? `openclaw-${oc.id}`;
          const params: ProvisionAgentParams = {
            runtime: "openclaw-acp",
            name,
            bio: `OpenClaw agent ${oc.id} adopted from gateway ${gw.name}.`,
            openclaw: { gateway: gw.name, agent: oc.id },
          };
          const credentials = await materializeCredentials(params, freshCfg, {
            gateway: ctx.gateway,
            register,
          }, undefined);
          const installed = await installLocalAgent(credentials, {
            gateway: ctx.gateway,
            register,
            cfg: freshCfg,
            source: "adopted-openclaw",
          });
          result.adopted.push(installed.agentId);
        } catch (err) {
          result.failed.push({
            gateway: gw.name,
            openclawAgent: oc.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      });
    }
  }
  return result;
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
 * TTL for the L1 runtime-detection cache. `detectRuntimes()` shells out to
 * each adapter binary (claude / codex / gemini / openclaw / hermes) to read
 * `--version`, which routinely costs 1.5–2s in aggregate — long enough to
 * push `list_runtimes` past the Hub's 10s ack budget when combined with the
 * 3s openclaw gateway probe. Versions don't change between dashboard refresh
 * clicks, so cache the L1 snapshot briefly and recompute on miss.
 */
const RUNTIME_PROBE_CACHE_TTL_MS = 30_000;

let _runtimeProbeCache: { at: number; value: ListRuntimesResult } | null = null;

/** Drop the cache (e.g. before a `doctor`-style interactive re-probe). */
export function clearRuntimeProbeCache(): void {
  _runtimeProbeCache = null;
}

/**
 * Probe every registered adapter and shape the result as the wire-level
 * {@link ListRuntimesResult} — used by both the `list_runtimes` ack path and
 * the daemon-side first-connect `runtime_snapshot` push in `daemon.ts`.
 *
 * Cached for {@link RUNTIME_PROBE_CACHE_TTL_MS}; pass `{ force: true }` to
 * bypass the cache.
 */
export function collectRuntimeSnapshot(opts: { force?: boolean } = {}): ListRuntimesResult {
  if (
    !opts.force &&
    _runtimeProbeCache &&
    Date.now() - _runtimeProbeCache.at < RUNTIME_PROBE_CACHE_TTL_MS
  ) {
    return _runtimeProbeCache.value;
  }
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
  const value: ListRuntimesResult = { runtimes, probedAt: Date.now() };
  _runtimeProbeCache = { at: Date.now(), value };
  return value;
}

/** Maximum number of `endpoints[]` entries persisted per runtime (RFC §3.8.2). */
export const RUNTIME_ENDPOINTS_CAP = 32;

/** Injection seam for L2 + L3 endpoint probes — kept testable + side-effect-free. */
export type WsEndpointProbeFn = (args: {
  url: string;
  token?: string;
  timeoutMs: number;
}) => Promise<{
  ok: boolean;
  version?: string;
  /**
   * L3 — populated when `agents.list` succeeds. `id` is the stable key
   * consumed by route lookups / `openclawAgent`; `name` is display-only.
   */
  agents?: Array<{
    id: string;
    name?: string;
    workspace?: string;
    model?: { name?: string; provider?: string };
  }>;
  error?: string;
}>;

/**
 * Default L2 + L3 probe — speaks OpenClaw's WS frame protocol against the
 * gateway and enumerates agent profiles via `agents.list`.
 *
 * Wire flow (see `~/claws/openclaw/src/gateway/server/ws-connection/message-handler.ts`
 * and `~/claws/openclaw/src/gateway/protocol/schema/frames.ts`):
 *   1. WS upgrade (no auth required at the HTTP layer).
 *   2. Server emits `{type:"event", event:"connect.challenge", payload:{nonce}}`.
 *   3. Client sends `{type:"req", id, method:"connect", params:{minProtocol, maxProtocol,
 *      client:{id:"openclaw-probe", mode:"probe", ...}, auth:{token}}}`.
 *   4. Server responds `{type:"res", id, ok:true, payload:{type:"hello-ok", server:{version}, ...}}`.
 *   5. Client sends `{type:"req", id, method:"agents.list", params:{}}`.
 *   6. Server responds with `{payload: { defaultId, mainKey, scope, agents:[{id, name?, workspace?, model?}] }}`.
 *
 * Best-effort: a successful WS open with a failed handshake / `agents.list`
 * still reports `ok: true` (just without `agents`), matching the RFC's
 * "agents populated only when listing succeeded" rule.
 */
async function defaultWsProbe(args: {
  url: string;
  token?: string;
  timeoutMs: number;
}): Promise<{
  ok: boolean;
  version?: string;
  agents?: Array<{
    id: string;
    name?: string;
    workspace?: string;
    model?: { name?: string; provider?: string };
  }>;
  error?: string;
}> {
  type AgentRow = {
    id: string;
    name?: string;
    workspace?: string;
    model?: { name?: string; provider?: string };
  };
  type ProbeResult = {
    ok: boolean;
    version?: string;
    agents?: AgentRow[];
    error?: string;
  };
  const { default: WebSocket } = await import("ws");
  return new Promise<ProbeResult>((resolve) => {
    let settled = false;
    let ws: any;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let serverVersion: string | undefined;
    const CONNECT_ID = "probe-connect";
    let connectSent = false;
    const settle = (v: ProbeResult): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try {
        ws?.terminate();
      } catch {
        // ignore
      }
      resolve(v);
    };
    try {
      const headers: Record<string, string> = {};
      // Some deployments gate the WS upgrade on Authorization too; harmless
      // when not enforced — auth is also re-asserted in the connect frame.
      if (args.token) headers["Authorization"] = `Bearer ${args.token}`;
      ws = new WebSocket(args.url, { headers });
    } catch (err) {
      resolve({ ok: false, error: (err as Error).message });
      return;
    }
    timer = setTimeout(() => settle({ ok: false, error: "timeout" }), args.timeoutMs);

    const sendConnect = (): void => {
      if (connectSent) return;
      connectSent = true;
      const params: any = {
        minProtocol: 3,
        maxProtocol: 3,
        client: {
          id: "openclaw-probe",
          version: "0.1.0",
          platform: process.platform || "node",
          mode: "probe",
        },
        role: "operator",
        scopes: ["operator.read"],
      };
      if (args.token) params.auth = { token: args.token };
      try {
        ws.send(JSON.stringify({ type: "req", id: CONNECT_ID, method: "connect", params }));
      } catch (err) {
        settle({ ok: true, error: `connect send failed: ${(err as Error).message}` });
      }
    };

    ws.on("open", () => {
      // Some servers send `connect.challenge` before the socket is fully
      // wired; if it never arrives we still try a best-effort connect after
      // a short delay so the probe doesn't stall on legacy gateways.
      setTimeout(() => {
        if (!connectSent && !settled) sendConnect();
      }, 250);
    });
    ws.on("message", (raw: Buffer | string) => {
      let msg: any;
      try {
        msg = JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8"));
      } catch {
        return;
      }
      if (!msg || typeof msg !== "object") return;
      if (msg.type === "event" && msg.event === "connect.challenge") {
        // Nonce only matters for device-pairing flows; token-only auth ignores it.
        sendConnect();
        return;
      }
      if (msg.type !== "res" || typeof msg.id !== "string") return;
      if (msg.id === CONNECT_ID) {
        if (!msg.ok) {
          const errMsg = msg.error?.message ? String(msg.error.message) : "connect rejected";
          settle({ ok: true, error: errMsg });
          return;
        }
        const v = msg.payload?.server?.version;
        if (typeof v === "string" && v) serverVersion = v;
        // We don't fetch agents.list over the wire: it requires `operator.read`
        // which the gateway only grants to clients that present a paired device
        // identity (see message-handler.ts:478 — self-declared scopes are
        // cleared without device pairing). For local OpenClaw the agent list
        // is sourced directly from disk by `probeOpenclawAgents`.
        settle({ ok: true, version: serverVersion });
      }
    });
    ws.on("error", (err: Error) => {
      settle({ ok: false, error: err.message });
    });
    ws.on("close", () => {
      // If the socket closes before we got our agents.list response, treat
      // L2 as ok (the upgrade succeeded) and emit no agents.
      settle({ ok: true, version: serverVersion });
    });
  });
}

export async function probeOpenclawAgents(
  profile: { url: string; token?: string; tokenFile?: string },
  opts: { timeoutMs?: number; probe?: WsEndpointProbeFn } = {},
): Promise<{
  ok: boolean;
  version?: string;
  agents?: Array<{
    id: string;
    name?: string;
    workspace?: string;
    model?: { name?: string; provider?: string };
  }>;
  error?: string;
}> {
  const probe = opts.probe ?? defaultWsProbe;
  const prepared = prepareGatewayProfile({
    name: "probe",
    url: profile.url,
    ...(profile.token ? { token: profile.token } : {}),
    ...(profile.tokenFile ? { tokenFile: profile.tokenFile } : {}),
  });
  const result = await probe({
    url: profile.url,
    token: prepared.resolvedToken,
    timeoutMs: opts.timeoutMs ?? 3000,
  });
  // For loopback gateways the agent roster lives in `~/.openclaw/openclaw.json`
  // and is the source of truth — listing it over the wire would require a
  // paired device identity (operator.read scope). When the WS probe is the
  // default (i.e. no test injection) we enrich the result from disk.
  if (result.ok && !result.agents && !opts.probe && isLoopbackUrl(profile.url)) {
    const local = readLocalOpenclawAgents();
    if (local && local.length > 0) result.agents = local;
  }
  return result;
}

function isLoopbackUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.hostname === "127.0.0.1" || u.hostname === "::1" || u.hostname === "localhost";
  } catch {
    return false;
  }
}

function readLocalOpenclawAgents(): Array<{
  id: string;
  name?: string;
  workspace?: string;
  model?: { name?: string; provider?: string };
}> | null {
  try {
    const file = path.join(homedir(), ".openclaw", "openclaw.json");
    if (!existsSync(file)) return null;
    const cfg = JSON.parse(readFileSync(file, "utf8")) as any;
    const list = Array.isArray(cfg?.agents?.list) ? cfg.agents.list : [];
    const defaultId = typeof cfg?.agents?.defaults?.id === "string" ? cfg.agents.defaults.id : "default";
    const seen = new Set<string>();
    const out: Array<{ id: string; name?: string; workspace?: string; model?: { name?: string; provider?: string } }> = [];
    const push = (raw: any, fallbackId?: string): void => {
      const id = typeof raw?.id === "string" && raw.id ? raw.id : fallbackId;
      if (!id || seen.has(id)) return;
      seen.add(id);
      const row: { id: string; name?: string; workspace?: string; model?: { name?: string; provider?: string } } = { id };
      if (typeof raw?.name === "string") row.name = raw.name;
      if (typeof raw?.workspace === "string") row.workspace = raw.workspace;
      const identityName = resolveOpenclawIdentityName(id, row.workspace, cfg);
      if (identityName) row.name = identityName;
      const m = raw?.model;
      if (m && typeof m === "object") {
        const model: { name?: string; provider?: string } = {};
        if (typeof m.primary === "string") model.name = m.primary;
        else if (typeof m.name === "string") model.name = m.name;
        if (typeof m.provider === "string") model.provider = m.provider;
        if (model.name || model.provider) row.model = model;
      }
      out.push(row);
    };
    // Default agent first so it surfaces at the top of the dropdown.
    push({ id: defaultId, workspace: cfg?.agents?.defaults?.workspace, model: cfg?.agents?.defaults?.model }, defaultId);
    for (const entry of list) push(entry);
    return out;
  } catch {
    return null;
  }
}

function resolveOpenclawIdentityName(
  agentId: string,
  workspace?: string,
  cfg?: any,
): string | undefined {
  const root = workspace ?? resolveOpenclawWorkspace(agentId, cfg);
  if (!root) return undefined;
  const file = path.join(expandHomePath(root), "IDENTITY.md");
  try {
    if (!existsSync(file)) return undefined;
    return parseIdentityName(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

function resolveOpenclawWorkspace(agentId: string, cfg?: any): string | undefined {
  let parsed = cfg;
  if (!parsed) {
    try {
      const file = path.join(homedir(), ".openclaw", "openclaw.json");
      if (!existsSync(file)) return undefined;
      parsed = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      return undefined;
    }
  }

  const defaults = parsed?.agents?.defaults;
  const defaultId = typeof defaults?.id === "string" && defaults.id ? defaults.id : "default";
  if ((agentId === defaultId || agentId === "default") && typeof defaults?.workspace === "string") {
    return defaults.workspace;
  }

  const list = Array.isArray(parsed?.agents?.list) ? parsed.agents.list : [];
  for (const entry of list) {
    if (entry?.id === agentId && typeof entry.workspace === "string") return entry.workspace;
  }
  return undefined;
}

function parseIdentityName(raw: string): string | undefined {
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*-\s*\*\*Name:\*\*\s*(.+?)\s*$/i);
    if (!m) continue;
    const name = m[1].trim();
    if (name && !name.startsWith("_(")) return name;
  }
  return undefined;
}

function expandHomePath(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return path.join(homedir(), p.slice(2));
  return p;
}

/**
 * Async variant that includes L2 (gateway reachability) and L3 (agent listing)
 * probes for runtimes that talk to external services. Used by the production
 * `list_runtimes` and first-connect snapshot paths.
 *
 * `cfg` is optional so existing callers without a loaded config (e.g. tests)
 * can keep using the sync `collectRuntimeSnapshot()` — when absent, the result
 * is identical to that function.
 */
export async function collectRuntimeSnapshotAsync(opts: {
  cfg?: { openclawGateways?: Array<{ name: string; url: string; token?: string; tokenFile?: string }> };
  wsProbe?: WsEndpointProbeFn;
  timeoutMs?: number;
} = {}): Promise<ListRuntimesResult> {
  const base = collectRuntimeSnapshot();
  const gateways = opts.cfg?.openclawGateways ?? [];
  if (gateways.length === 0) return base;
  // Default daemon-side budget is 3s — it must stay below the Hub's
  // `list_runtimes` ack wait (10s, see backend/hub/routers/daemon_control.py)
  // so a single slow gateway can't blow the whole snapshot to a 504.
  const timeoutMs = opts.timeoutMs ?? 3000;
  const capped = gateways.slice(0, RUNTIME_ENDPOINTS_CAP);
  const endpoints = await Promise.all(
    capped.map(async (g) => {
      try {
        const res = await probeOpenclawAgents(g, {
          probe: opts.wsProbe,
          timeoutMs,
        });
        const entry: any = { name: g.name, url: g.url, reachable: res.ok };
        if (res.version) entry.version = res.version;
        if (res.error) entry.error = res.error;
        if (res.agents) entry.agents = res.agents;
        return entry;
      } catch (err) {
        return {
          name: g.name,
          url: g.url,
          reachable: false,
          error: (err as Error).message,
        };
      }
    }),
  );
  const out: ListRuntimesResult = { ...base };
  out.runtimes = base.runtimes.map((r) =>
    r.id === "openclaw-acp" ? { ...r, endpoints } : r,
  );
  return out;
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
): Record<string, { runtime?: string; cwd?: string; openclawGateway?: string; openclawAgent?: string }> {
  const out: Record<string, { runtime?: string; cwd?: string; openclawGateway?: string; openclawAgent?: string }> = {};
  for (const id of agentIds) {
    const file = defaultCredentialsFile(id);
    try {
      if (!existsSync(file)) continue;
      const creds = loadStoredCredentials(file);
      const entry: { runtime?: string; cwd?: string; openclawGateway?: string; openclawAgent?: string } = {};
      if (creds.runtime) entry.runtime = creds.runtime;
      if (creds.cwd) entry.cwd = creds.cwd;
      if (creds.openclawGateway) entry.openclawGateway = creds.openclawGateway;
      if (creds.openclawAgent) entry.openclawAgent = creds.openclawAgent;
      if (entry.runtime || entry.cwd || entry.openclawGateway || entry.openclawAgent) out[id] = entry;
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

  // Fall back to defaultRoute.extraArgs (mirrors adapter/cwd inheritance
  // above) so dashboard-driven `set_route` calls that only carry agentId +
  // pattern still pick up operator-wide flags like `--permission-mode
  // bypassPermissions`. Without this, every newly provisioned agent lost
  // those flags and Bash/MCP tool calls would deadlock on permission prompts.
  const extraArgs = Array.isArray(route?.extraArgs)
    ? route!.extraArgs!.slice()
    : Array.isArray(cfg.defaultRoute.extraArgs)
      ? cfg.defaultRoute.extraArgs.slice()
      : undefined;
  const newRule: RouteRule = {
    match,
    adapter,
    cwd,
    ...(extraArgs ? { extraArgs } : {}),
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
  if (ids.length === 0) {
    const discovered = discoverAgentCredentials({
      credentialsDir: path.join(homedir(), ".botcord", "credentials"),
    });
    for (const a of discovered.agents) {
      if (a.hubUrl) return a.hubUrl;
    }
  }
  return null;
}
