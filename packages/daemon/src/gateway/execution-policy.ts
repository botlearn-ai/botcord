/**
 * Requester-derived execution policy (agent-sharing M0).
 *
 * Until per-requester grants exist, every turn is either owner-trusted (runs
 * with the route's normal permissions) or restricted (read-only tools, no
 * shell, replies delivered by the daemon). A turn is owner-trusted only when
 * the inbound provably originates from the agent's owner or an owner-issued
 * system path; any other BotCord sender — other humans and agents in rooms,
 * DMs, contact requests — is restricted unless the route opts out with
 * `nonOwnerExecution: "full"`.
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

function readSourceTypes(raw: unknown): string[] {
  if (!raw || typeof raw !== "object") return [];
  const batch = (raw as { batch?: unknown }).batch;
  if (Array.isArray(batch) && batch.length > 0) {
    return batch.map((entry) =>
      entry && typeof entry === "object" && typeof (entry as { source_type?: unknown }).source_type === "string"
        ? ((entry as { source_type: string }).source_type)
        : "",
    );
  }
  const sourceType = (raw as { source_type?: unknown }).source_type;
  return typeof sourceType === "string" ? [sourceType] : [""];
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
  const sourceTypes = readSourceTypes(msg.raw);
  return sourceTypes.length > 0 && sourceTypes.every((t) => OWNER_SOURCE_TYPES.has(t));
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
  if (route.nonOwnerExecution === "full") return false;
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
