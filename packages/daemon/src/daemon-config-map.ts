import type {
  GatewayChannelConfig,
  GatewayConfig,
  GatewayRoute,
  RouteMatch,
  TrustLevel as GatewayTrustLevel,
} from "./gateway/index.js";
import type { DaemonConfig, RouteRule } from "./config.js";
import { resolveAgentIds } from "./config.js";
import { log as daemonLog } from "./log.js";

/** Options accepted by {@link toGatewayConfig}. */
export interface ToGatewayConfigOptions {
  /**
   * Explicit list of agent ids to bind channels to. When provided, overrides
   * anything derivable from the daemon config itself. P1 passes discovered
   * credentials in via this field so `toGatewayConfig` stays pure.
   */
  agentIds?: string[];
  /**
   * Per-agent runtime/cwd cached from credentials (see
   * `docs/agent-runtime-property-plan.md`). When present for an agent id,
   * `toGatewayConfig` synthesizes a terminal route pinning that agent's
   * turns to its runtime. Explicit `cfg.routes` entries still win because
   * synthesized routes are appended after them.
   */
  agentRuntimes?: Record<string, { runtime?: string; cwd?: string }>;
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
function mapRoute(r: RouteRule): GatewayRoute {
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
  return {
    match,
    runtime: r.adapter,
    cwd: r.cwd,
    extraArgs: r.extraArgs,
    trustLevel: mapTrustLevel(rawTrust),
  };
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

  const routes: GatewayRoute[] = (cfg.routes ?? []).map(mapRoute);

  // Synthesize a per-agent terminal route for every agent that has a cached
  // runtime in its credentials. Appended after the user's explicit routes so
  // `cfg.routes` still wins on conflict, but ahead of the `defaultRoute`
  // fallback so the agent's own runtime takes precedence over the daemon-wide
  // default (docs/agent-runtime-property-plan.md §4.3).
  const agentRuntimes = opts.agentRuntimes ?? {};
  for (const agentId of agentIds) {
    const meta = agentRuntimes[agentId];
    if (!meta?.runtime) continue;
    routes.push({
      match: { accountId: agentId },
      runtime: meta.runtime,
      cwd: meta.cwd || defaultRoute.cwd,
      // Inherit defaults for the rest. `extraArgs`/`queueMode`/`trustLevel`
      // stay unset so the gateway's own defaults apply.
    });
  }

  return {
    channels,
    defaultRoute,
    routes,
    streamBlocks: cfg.streamBlocks,
  };
}
