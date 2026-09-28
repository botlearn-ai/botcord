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

/** Runtimes that can run the collaborator profile (edits confined to a worktree). */
export const COLLABORATOR_CAPABLE_RUNTIMES: ReadonlySet<string> = new Set(["claude-code", "codex"]);

/** Agent-sharing grant as attached by the Hub (`InboxMessage.access_context`). */
export interface TurnAccessGrant {
  grantId: string;
  spaceId: string;
  role: "consultant" | "collaborator";
  requesterId: string;
  workspacePath: string | null;
  allowedCommands: string[];
}

/**
 * Execution profile for one turn:
 *  - `default`: route's normal permissions (owner or legacy non-owner)
 *  - `restricted`: read-only tools / sandbox, daemon-delivered reply
 *  - `collaborator`: edits confined to a per-grant workspace, daemon-delivered reply
 *  - `refused`: must not reach the runtime (grant inactive, or the runtime
 *    cannot enforce the grant); the daemon replies with `reason`
 */
export type TurnExecution =
  | { profile: "default" }
  | { profile: "restricted"; grant?: TurnAccessGrant }
  | { profile: "collaborator"; grant: TurnAccessGrant }
  | { profile: "refused"; reason: "grant_inactive" | "runtime_unsupported"; grant: TurnAccessGrant };

function readAccessContext(entry: unknown): { grant: TurnAccessGrant; active: boolean } | null {
  if (!entry || typeof entry !== "object") return null;
  const ctx = (entry as { access_context?: unknown }).access_context;
  if (!ctx || typeof ctx !== "object") return null;
  const c = ctx as Record<string, unknown>;
  if (typeof c.grant_id !== "string" || typeof c.requester_id !== "string") return null;
  const role = c.role === "collaborator" ? "collaborator" : "consultant";
  return {
    active: c.active === true,
    grant: {
      grantId: c.grant_id,
      spaceId: typeof c.space_id === "string" ? c.space_id : "",
      role,
      requesterId: c.requester_id,
      workspacePath: typeof c.workspace_path === "string" && c.workspace_path ? c.workspace_path : null,
      allowedCommands: Array.isArray(c.allowed_commands)
        ? c.allowed_commands.filter((x): x is string => typeof x === "string")
        : [],
    },
  };
}

/**
 * Resolve the execution profile for a turn. Grant-bearing inbound (Hub
 * `access_context`) always wins over route config: a shared agent is never
 * run with full permissions for a grantee, and an inactive grant never runs.
 */
export function resolveTurnExecution(
  msg: GatewayInboundMessage,
  route: Pick<GatewayRoute, "nonOwnerExecution" | "runtime">,
  opts: { botcordChannel: boolean },
): TurnExecution {
  if (isOwnerTrustedInbound(msg, opts)) return { profile: "default" };
  const batch = (msg.raw as { batch?: unknown } | null | undefined)?.batch;
  const entries = Array.isArray(batch) && batch.length > 0 ? batch : [msg.raw];
  const contexts = entries.map(readAccessContext);
  const withGrant = contexts.filter((c): c is NonNullable<typeof c> => c !== null);
  if (withGrant.length > 0) {
    const latest = withGrant[withGrant.length - 1]!;
    if (withGrant.some((c) => !c.active)) {
      return { profile: "refused", reason: "grant_inactive", grant: latest.grant };
    }
    // Mixed batches (grantee + non-grant senders) fall back to read-only.
    const collaborator =
      latest.grant.role === "collaborator" &&
      withGrant.length === entries.length &&
      withGrant.every((c) => c.grant.grantId === latest.grant.grantId);
    if (collaborator && COLLABORATOR_CAPABLE_RUNTIMES.has(route.runtime)) {
      return { profile: "collaborator", grant: latest.grant };
    }
    if (RESTRICTION_CAPABLE_RUNTIMES.has(route.runtime)) {
      return { profile: "restricted", grant: latest.grant };
    }
    return { profile: "refused", reason: "runtime_unsupported", grant: latest.grant };
  }
  return isRestrictedTurn(msg, route, opts) ? { profile: "restricted" } : { profile: "default" };
}

const GUEST_ENV_DROP_EXACT = new Set([
  "SSH_AUTH_SOCK",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GITLAB_TOKEN",
  "NPM_TOKEN",
  "NODE_AUTH_TOKEN",
  "DATABASE_URL",
  "GOOGLE_APPLICATION_CREDENTIALS",
]);
const GUEST_ENV_DROP_PREFIX = /^(AWS|AZURE|GCP|GCLOUD|CLOUDSDK)_/;
const GUEST_ENV_SECRETISH = /TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE_KEY/i;
/** Runtime auth the CLI itself needs; never handed to guest-requested tools beyond the CLI. */
const GUEST_ENV_KEEP_PREFIX = /^(ANTHROPIC|CLAUDE|OPENAI|CODEX|GEMINI|GOOGLE_GENAI|DEEPSEEK|KIMI|MOONSHOT)_/;

/**
 * Remove host credentials from the environment of a restricted/collaborator
 * turn so commands a non-owner triggers cannot reach the owner's git, cloud
 * or package-registry identities. Runtime CLI auth variables are kept.
 */
export function scrubGuestEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    if (GUEST_ENV_KEEP_PREFIX.test(name)) {
      out[name] = value;
      continue;
    }
    if (GUEST_ENV_DROP_EXACT.has(name) || GUEST_ENV_DROP_PREFIX.test(name) || GUEST_ENV_SECRETISH.test(name)) {
      continue;
    }
    out[name] = value;
  }
  return out;
}
