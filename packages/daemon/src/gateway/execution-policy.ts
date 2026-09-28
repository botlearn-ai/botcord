/**
 * Requester-derived execution policy (agent-sharing M0).
 *
 * Until per-requester grants exist, every turn on a restricted route is
 * either owner-trusted (runs with the route's normal permissions) or restricted (read-only tools, no
 * shell, replies delivered by the daemon). A turn is owner-trusted only when
 * the inbound provably originates from the agent's owner or an owner-issued
 * system path, or when the Hub marks the sender as owned by the same owner
 * (`sender_same_owner`, e.g. the owner's other agents or the owner posting in
 * a room). Any other BotCord sender — other humans and agents in rooms, DMs,
 * contact requests — is restricted when the route opts in with
 * `nonOwnerExecution: "restricted"`.
 *
 * Opt-in for now: personal mode keeps the legacy full-permission behavior;
 * team mode / agent sharing enables restriction for the routes it manages.
 */
import type { GatewayInboundMessage, GatewayRoute } from "./types.js";

export type { NonOwnerExecution } from "./types.js";

const OWNER_CHAT_PREFIX = "rm_oc_";

/**
 * `source_type` values that identify owner-issued inbound:
 *  - `dashboard_user_chat`: owner typing in the dashboard chat
 *  - `cloud_agent_run`: Hub-issued run on the owner's behalf
 *  - `botcord_schedule`: daemon-synthesized from a signed `wake_agent` frame
 *  - `cloud_gateway_ingress`: owner-configured third-party gateway
 */
const OWNER_SOURCE_TYPES = new Set([
  "dashboard_user_chat",
  "cloud_agent_run",
  "botcord_schedule",
  "cloud_gateway_ingress",
]);

/** One inbound entry (the message itself, or each member of a batch) is owner-trusted. */
function entryOwnerTrusted(entry: unknown): boolean {
  if (!entry || typeof entry !== "object") return false;
  const { source_type: sourceType, sender_same_owner: sameOwner } = entry as {
    source_type?: unknown;
    sender_same_owner?: unknown;
  };
  if (sameOwner === true) return true;
  return typeof sourceType === "string" && OWNER_SOURCE_TYPES.has(sourceType);
}

/**
 * Whether the inbound's requester is the agent owner (or an owner-issued
 * system path). Third-party channels (Telegram / WeChat / Feishu) are
 * gated by the owner's own sender allowlists, so they count as owner-trusted.
 */
export function isOwnerTrustedInbound(
  msg: GatewayInboundMessage,
  opts: { botcordChannel: boolean },
): boolean {
  if (!opts.botcordChannel) return true;
  if (msg.conversation.id.startsWith(OWNER_CHAT_PREFIX)) return true;
  const batch = (msg.raw as { batch?: unknown } | null | undefined)?.batch;
  if (Array.isArray(batch) && batch.length > 0) return batch.every(entryOwnerTrusted);
  return entryOwnerTrusted(msg.raw);
}

/**
 * Runtimes whose adapters enforce the restricted profile when handed
 * `trustLevel: "public"` (read-only tools / sandbox, no shell). Kimi and
 * OpenClaw ACP cannot be constrained from the daemon today, so their
 * non-owner turns keep the legacy behavior (see {@link restrictionUnsupported}).
 */
export const RESTRICTION_CAPABLE_RUNTIMES: ReadonlySet<string> = new Set([
  "claude-code",
  "codex",
  "gemini",
  "hermes-agent",
  "deepseek-tui",
]);

function wantsRestriction(
  msg: GatewayInboundMessage,
  route: Pick<GatewayRoute, "nonOwnerExecution">,
  opts: { botcordChannel: boolean },
): boolean {
  if (route.nonOwnerExecution !== "restricted") return false;
  return !isOwnerTrustedInbound(msg, opts);
}

/** Whether this turn must run with the restricted execution profile. */
export function isRestrictedTurn(
  msg: GatewayInboundMessage,
  route: Pick<GatewayRoute, "nonOwnerExecution" | "runtime">,
  opts: { botcordChannel: boolean },
): boolean {
  return wantsRestriction(msg, route, opts) && RESTRICTION_CAPABLE_RUNTIMES.has(route.runtime);
}

/** Non-owner turn that should be restricted but whose runtime cannot enforce it. */
export function restrictionUnsupported(
  msg: GatewayInboundMessage,
  route: Pick<GatewayRoute, "nonOwnerExecution" | "runtime">,
  opts: { botcordChannel: boolean },
): boolean {
  return wantsRestriction(msg, route, opts) && !RESTRICTION_CAPABLE_RUNTIMES.has(route.runtime);
}
