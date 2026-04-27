import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type {
  GatewayChannelConfig,
  GatewayConfig,
  GatewayRoute,
  ResolvedOpenclawGateway,
  RouteMatch,
  TrustLevel as GatewayTrustLevel,
} from "./gateway/index.js";
import type {
  DaemonConfig,
  DaemonRouteDefault,
  OpenclawGatewayProfile,
  RouteRule,
} from "./config.js";
import { resolveAgentIds } from "./config.js";
import { agentWorkspaceDir } from "./agent-workspace.js";
import { log as daemonLog } from "./log.js";

/** Per-agent metadata cached from credentials, used by `buildManagedRoutes`. */
export interface AgentRuntimeMeta {
  runtime?: string;
  cwd?: string;
  /** OpenClaw gateway profile name to lookup in the registry. */
  openclawGateway?: string;
  /** Optional override of the OpenClaw agent profile within the gateway. */
  openclawAgent?: string;
}

/** Profile + tokenFile-resolved bearer token. Exported so other module-boundary
 *  paths (runtime probing, post-provision hot-add) reuse the same resolver
 *  instead of duplicating tokenFile semantics. */
export interface PreparedGatewayProfile extends OpenclawGatewayProfile {
  /** Token actually usable at dispatch time; empty when load failed. */
  resolvedToken?: string;
  /** Reason `resolvedToken` is empty, for logs. */
  tokenError?: string;
}

function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return path.join(homedir(), p.slice(2));
  return p;
}

/** Resolve one profile's token (inline > tokenFile). Failures are swallowed
 *  into `tokenError`; `resolvedToken` is left undefined. Logs at warn for ops
 *  visibility. */
export function prepareGatewayProfile(
  p: OpenclawGatewayProfile,
): PreparedGatewayProfile {
  const prepared: PreparedGatewayProfile = { ...p };
  if (p.token && p.token.length > 0) {
    prepared.resolvedToken = p.token;
  } else if (p.tokenFile && p.tokenFile.length > 0) {
    try {
      prepared.resolvedToken = readFileSync(expandHome(p.tokenFile), "utf8").trim();
    } catch (err: any) {
      prepared.tokenError = err?.message ?? String(err);
      daemonLog.warn("daemon.config.openclaw.tokenfile_failed", {
        gateway: p.name,
        tokenFile: p.tokenFile,
        error: prepared.tokenError,
      });
    }
  }
  return prepared;
}

/** Build a name → prepared-profile map for a config's gateway registry. */
export function prepareGatewayProfiles(
  profiles: OpenclawGatewayProfile[] | undefined,
): Map<string, PreparedGatewayProfile> {
  const out = new Map<string, PreparedGatewayProfile>();
  if (!profiles) return out;
  for (const p of profiles) out.set(p.name, prepareGatewayProfile(p));
  return out;
}

function resolveGateway(
  profiles: Map<string, PreparedGatewayProfile>,
  gatewayName: string | undefined,
  agentOverride: string | undefined,
  where: string,
): ResolvedOpenclawGateway | undefined {
  if (!gatewayName) {
    daemonLog.warn("daemon.config.openclaw.missing_gateway", { where });
    return undefined;
  }
  const profile = profiles.get(gatewayName);
  if (!profile) {
    daemonLog.warn("daemon.config.openclaw.unknown_gateway", { where, gateway: gatewayName });
    return undefined;
  }
  const resolved: ResolvedOpenclawGateway = {
    name: profile.name,
    url: profile.url,
  };
  if (profile.resolvedToken) resolved.token = profile.resolvedToken;
  const agent = agentOverride ?? profile.defaultAgent;
  if (agent) resolved.openclawAgent = agent;
  return resolved;
}

/** Options accepted by {@link toGatewayConfig}. */
export interface ToGatewayConfigOptions {
  /**
   * Explicit list of agent ids to bind channels to. When provided, overrides
   * anything derivable from the daemon config itself. P1 passes discovered
   * credentials in via this field so `toGatewayConfig` stays pure.
   */
  agentIds?: string[];
  /**
   * Per-agent runtime/cwd cached from credentials. When present for an agent
   * id, `toGatewayConfig` synthesizes a terminal route pinning that agent's
   * turns to its runtime. Explicit `cfg.routes` entries still win because
   * synthesized routes are appended after them.
   */
  agentRuntimes?: Record<string, AgentRuntimeMeta>;
}

/**
 * Historical channel id used when the daemon bound a single agent. Kept as a
 * named export for any downstream reader that still references it; no new
 * code paths in the daemon emit this id — channels are now keyed by agentId.
 *
 * @deprecated Channel ids are now the agentId itself.
 */
export const DEFAULT_BOTCORD_CHANNEL_ID = "botcord-main";

/** Channel `type` tag used by `createBotCordChannel`. */
export const BOTCORD_CHANNEL_TYPE = "botcord";

/**
 * Map daemon's historical narrower TrustLevel ("owner" | "untrusted") onto
 * gateway's ("owner" | "trusted" | "public"). Matches the adapter-level
 * mapping in `adapters/runtimes.ts`: "untrusted" collapses to "public".
 * Accepts `undefined` → `undefined` so callers can pass through.
 */
function mapTrustLevel(
  level: "owner" | "untrusted" | undefined,
): GatewayTrustLevel | undefined {
  if (level === undefined) return undefined;
  return level === "owner" ? "owner" : "public";
}

/**
 * Translate a single daemon route rule into a gateway route. Gateway matches
 * on the channel-agnostic fields; the daemon surface keeps the legacy
 * `roomId`/`roomPrefix` aliases for backward compatibility. When both a
 * legacy alias and its canonical field are present, the canonical field
 * wins and a warning is logged.
 */
function mapRoute(
  r: RouteRule,
  profiles: Map<string, PreparedGatewayProfile>,
  index: number,
): GatewayRoute {
  const match: RouteMatch = {};
  if (r.match.channel) match.channel = r.match.channel;
  if (r.match.accountId) match.accountId = r.match.accountId;

  if (r.match.conversationId && r.match.roomId && r.match.conversationId !== r.match.roomId) {
    daemonLog.warn("daemon.config.route.conflict", {
      field: "conversationId",
      roomId: r.match.roomId,
      conversationId: r.match.conversationId,
      resolution: "conversationId wins",
    });
  }
  const conversationId = r.match.conversationId ?? r.match.roomId;
  if (conversationId) match.conversationId = conversationId;

  if (
    r.match.conversationPrefix &&
    r.match.roomPrefix &&
    r.match.conversationPrefix !== r.match.roomPrefix
  ) {
    daemonLog.warn("daemon.config.route.conflict", {
      field: "conversationPrefix",
      roomPrefix: r.match.roomPrefix,
      conversationPrefix: r.match.conversationPrefix,
      resolution: "conversationPrefix wins",
    });
  }
  const conversationPrefix = r.match.conversationPrefix ?? r.match.roomPrefix;
  if (conversationPrefix) match.conversationPrefix = conversationPrefix;

  if (r.match.conversationKind) match.conversationKind = r.match.conversationKind;
  if (r.match.senderId) match.senderId = r.match.senderId;
  if (typeof r.match.mentioned === "boolean") match.mentioned = r.match.mentioned;

  const rawTrust = (r as { trustLevel?: "owner" | "untrusted" }).trustLevel;
  const out: GatewayRoute = {
    match,
    runtime: r.adapter,
    cwd: r.cwd,
    extraArgs: r.extraArgs,
    trustLevel: mapTrustLevel(rawTrust),
  };
  if (r.adapter === "openclaw-acp") {
    out.gateway = resolveGateway(
      profiles,
      r.gateway,
      r.openclawAgent,
      `routes[${index}]`,
    );
  }
  return out;
}

/**
 * Convert the daemon's on-disk config into a gateway runtime config. Only
 * used in-process at daemon boot; the daemon config file itself is the
 * user-facing contract.
 *
 * When `opts.agentIds` is provided (discovery or explicit override), the
 * mapper trusts that list verbatim. Otherwise it falls back to the legacy
 * `resolveAgentIds(cfg)` path so callers that haven't been updated for P1
 * keep working.
 */
export function toGatewayConfig(
  cfg: DaemonConfig,
  opts: ToGatewayConfigOptions = {},
): GatewayConfig {
  // One channel per configured agent. Channel id = agentId so session keys
  // (`runtime:channel:accountId:kind:convId`) and activity records carry
  // the agent identity end-to-end. Pre-multi-agent single-agent installs
  // previously used the fixed id "botcord-main"; existing on-disk session
  // entries keyed by that id are silently dropped on the first message
  // after upgrade — a one-time reset, not a bug.
  const agentIds = opts.agentIds ?? resolveAgentIds(cfg);
  const channels: GatewayChannelConfig[] = agentIds.map((agentId) => ({
    id: agentId,
    type: BOTCORD_CHANNEL_TYPE,
    accountId: agentId,
    agentId,
  }));

  // DaemonConfig's typed surface doesn't carry `trustLevel`, but we read it
  // defensively so future config extensions can propagate without a shape bump.
  const profiles = prepareGatewayProfiles(cfg.openclawGateways);

  const rawDefaultTrust = (cfg.defaultRoute as { trustLevel?: "owner" | "untrusted" })
    .trustLevel;
  const defaultRoute: GatewayRoute = {
    runtime: cfg.defaultRoute.adapter,
    cwd: cfg.defaultRoute.cwd,
    extraArgs: cfg.defaultRoute.extraArgs,
    // queueMode: omitted — dispatcher's kind-based default wins
    // (direct → cancel-previous, group → serial).
    trustLevel: mapTrustLevel(rawDefaultTrust),
  };
  if (cfg.defaultRoute.adapter === "openclaw-acp") {
    const dr = cfg.defaultRoute as DaemonRouteDefault;
    defaultRoute.gateway = resolveGateway(
      profiles,
      dr.gateway,
      dr.openclawAgent,
      "defaultRoute",
    );
  }

  const routes: GatewayRoute[] = (cfg.routes ?? []).map((r, i) => mapRoute(r, profiles, i));

  // Synthesize a per-agent route for every bound agent and hand it to the
  // gateway via the managed-routes bucket (plan §10.1). User-authored
  // `cfg.routes[]` stay untouched. Match priority (see router.ts):
  // `routes[] with explicit accountId → managedRoutes → other routes[] →
  // defaultRoute`. Broad prefix/kind rules no longer clobber the agent's
  // chosen runtime — only routes that name the agent by `accountId` do.
  const managedMap = buildManagedRoutes(
    agentIds,
    opts.agentRuntimes ?? {},
    defaultRoute,
    profiles,
  );

  return {
    channels,
    defaultRoute,
    routes,
    managedRoutes: Array.from(managedMap.values()),
    streamBlocks: cfg.streamBlocks,
  };
}

/**
 * Build the daemon's managed per-agent routes. Emits exactly one route per
 * `agentId`, keyed by `accountId`. `runtime` comes from the agent's cached
 * metadata when present (credentials file), otherwise falls back to
 * `defaultRoute.runtime`. `cwd` prefers the cached value but falls back to
 * the agent's workspace directory (see plan §10) so every agent runs inside
 * its own dedicated tree by default.
 *
 * Iteration order of `agentIds` is preserved in the resulting Map for test
 * determinism; the gateway router does not depend on map order.
 *
 * Exported so `reload_config` and `provisionAgent` hot-add can share the
 * same synthesis logic (plan §10.5).
 */
export function buildManagedRoutes(
  agentIds: string[],
  agentRuntimes: Record<string, AgentRuntimeMeta>,
  defaultRoute: GatewayRoute,
  openclawProfiles?: Map<string, PreparedGatewayProfile>,
): Map<string, GatewayRoute> {
  const out = new Map<string, GatewayRoute>();
  // Lazy-build profile map when caller didn't pass one (legacy callers).
  const profiles = openclawProfiles ?? new Map<string, PreparedGatewayProfile>();
  for (const agentId of agentIds) {
    const meta = agentRuntimes[agentId] ?? {};
    const runtime = meta.runtime ?? defaultRoute.runtime;
    const route: GatewayRoute = {
      match: { accountId: agentId },
      runtime,
      cwd: meta.cwd || agentWorkspaceDir(agentId),
      // Inherit defaultRoute's extraArgs so synthesized per-agent routes
      // pick up operator-wide flags (e.g. `--permission-mode bypassPermissions`)
      // that would otherwise apply only to agents listed in `cfg.routes[]`.
      ...(defaultRoute.extraArgs ? { extraArgs: defaultRoute.extraArgs.slice() } : {}),
    };
    if (runtime === "openclaw-acp") {
      // Per RFC §3.4: prefer credentials, fall back to defaultRoute.gateway.
      const gatewayName = meta.openclawGateway ?? defaultRoute.gateway?.name;
      const agentOverride = meta.openclawAgent;
      const resolved = gatewayName
        ? resolveGateway(profiles, gatewayName, agentOverride, `managedRoute[${agentId}]`)
        : defaultRoute.gateway;
      if (!resolved) {
        // No usable gateway — skip the managed route so defaultRoute can take over.
        daemonLog.warn("daemon.config.openclaw.managed_route_skipped", {
          agentId,
          gatewayName,
        });
        continue;
      }
      route.gateway = resolved;
    }
    out.set(agentId, route);
  }
  return out;
}
