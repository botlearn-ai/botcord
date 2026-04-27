/**
 * Wire types for the daemon control-plane frames exchanged over
 * `/daemon/ws`. Kept deliberately small — the control plane is still P0
 * and anything more than strict schema + routing should live in the
 * daemon `provision.ts` module.
 */

/** Canonical envelope carried on every inbound or outbound frame. */
export interface ControlFrame {
  /** Request id — used for ack correlation and idempotent dedupe. */
  id: string;
  /** Frame type, e.g. `provision_agent`, `revoke_agent`, `ping`. */
  type: string;
  /** Optional per-type parameter bag; concrete shape lives in handler code. */
  params?: Record<string, unknown>;
  /** Hub signature (required when the frame originated from Hub → daemon). */
  sig?: string;
  /** Millisecond timestamp for replay-window checks. */
  ts?: number;
}

/** Ack frame returned by the daemon after a `ControlFrame` is processed. */
export interface ControlAck {
  /** Correlates with the request's `id`. */
  id: string;
  ok: boolean;
  result?: unknown;
  error?: {
    code: string;
    message: string;
  };
}

/** Well-known control frame types. Keep in sync with Hub backend. */
export const CONTROL_FRAME_TYPES = {
  PING: "ping",
  PONG: "pong",
  HELLO: "hello",
  PROVISION_AGENT: "provision_agent",
  REVOKE_AGENT: "revoke_agent",
  RELOAD_CONFIG: "reload_config",
  LIST_AGENTS: "list_agents",
  SET_ROUTE: "set_route",
  /**
   * Hub→daemon: instance-level revoke. Daemon writes the auth-expired
   * flag and stops control-plane reconnect; agent data-plane channels
   * keep running with their existing agent tokens (plan §6.3).
   */
  REVOKE: "revoke",
  AGENT_PROVISIONED: "agent_provisioned",
  AGENT_REVOKED: "agent_revoked",
  CONFIG_RELOADED: "config_reloaded",
  /**
   * Hub→daemon: identity metadata (display name / bio) for an existing agent
   * has changed on the dashboard. Daemon rewrites the on-disk
   * `identity.md` for that agent. Sent best-effort while the daemon is
   * connected; offline daemons catch up via the `agents` snapshot embedded
   * on the next `hello` frame.
   */
  UPDATE_AGENT: "update_agent",
  /**
   * Hub→daemon: ask the daemon to re-probe locally installed AI CLI
   * runtimes (claude-code, codex, gemini, …) and return the current
   * snapshot. Used by the dashboard "refresh runtimes" button. Plan §8.5
   * "pull" path.
   */
  LIST_RUNTIMES: "list_runtimes",
  /**
   * Daemon→Hub: event frame carrying the latest runtime-probe snapshot.
   * Pushed on first control-WS connect (P0) and on reconnect/diff (P1).
   * Hub persists the payload onto `daemon_instances.runtimes_json` so the
   * dashboard can render "what's installed on this machine" even while the
   * daemon is offline. Plan §8.5 "push" path.
   */
  RUNTIME_SNAPSHOT: "runtime_snapshot",
  /**
   * Hub→daemon: invalidate the daemon's cached attention policy for a given
   * agent (and optionally a single room override). Sent by the BFF after
   * `PATCH /api/agents/{id}/policy` and the per-room override endpoints.
   * Payload shape: see {@link PolicyUpdatedParams}.
   */
  POLICY_UPDATED: "policy_updated",
} as const;

export type ControlFrameType = (typeof CONTROL_FRAME_TYPES)[keyof typeof CONTROL_FRAME_TYPES];

/**
 * Payload shape for `provision_agent`. Hub writes this from the dashboard
 * "add agent" flow; daemon registers the agent, writes credentials, and
 * tells gateway to `addChannel`.
 *
 * Fields are optional-by-type because Hub is the source-of-truth for what's
 * actually required; the daemon validates at the handler boundary.
 */
export interface ProvisionAgentParams {
  /** Display name to pass through to `POST /registry/agents`. */
  name?: string;
  /** Optional bio. */
  bio?: string;
  /**
   * Optional working directory to pin for routes that match this agent.
   * Only paths under the user's home directory are accepted by the
   * daemon — enforced in `provision.ts`, not here.
   */
  cwd?: string;
  /**
   * Runtime to bind to this agent (claude-code / codex / gemini / …).
   * Selected by the user at creation time; persists as an agent property
   * on both sides.
   */
  runtime?: string;
  /**
   * @deprecated alias for `runtime`, retained for one release so in-flight
   * Hub builds emitting the pre-rename name still work. Daemons prefer
   * `runtime` when both are present.
   */
  adapter?: string;
  /**
   * When present, the Hub has already registered the agent and is just
   * handing the credential envelope down. The daemon writes it to disk
   * verbatim and skips the register flow.
   */
  credentials?: {
    agentId: string;
    keyId: string;
    privateKey: string;
    publicKey?: string;
    token?: string;
    tokenExpiresAt?: number;
    hubUrl?: string;
    displayName?: string;
    /** Runtime bound to the agent, cached by the daemon for offline routing. */
    runtime?: string;
    /** Working directory cached alongside the runtime, for route synthesis. */
    cwd?: string;
    /**
     * OpenClaw gateway profile name to bind to this agent. Only meaningful
     * when `runtime === "openclaw-acp"`. Flat naming chosen to match the
     * existing flat shape of the `credentials` envelope.
     */
    openclawGateway?: string;
    /** Optional OpenClaw agent profile override for this agent. */
    openclawAgent?: string;
  };
  /**
   * OpenClaw runtime parameters. When `runtime === "openclaw-acp"` the daemon
   * routes this agent's turns through the named gateway profile (must exist in
   * `DaemonConfig.openclawGateways[].name`). Top-level nesting groups the
   * fields as a runtime cluster; the duplicate flat fields under `credentials`
   * exist because the credentials envelope is intentionally flat.
   */
  openclaw?: {
    /** References `DaemonConfig.openclawGateways[].name` on the daemon side. */
    gateway: string;
    /** Overrides `OpenclawGatewayProfile.defaultAgent` for this agent. */
    agent?: string;
  };
  /**
   * Optional initial attention policy seed. When the Hub already knows the
   * agent's stored `default_attention` and `attention_keywords` (i.e. a
   * non-fresh provision flow), it can hand the values down so the daemon's
   * `policyResolver` is warm before the first inbound message lands. Daemons
   * that don't recognize these fields safely ignore them (PR3 §5).
   */
  defaultAttention?: "always" | "mention_only" | "keyword" | "muted";
  attentionKeywords?: string[];
}

/**
 * Payload shape for `policy_updated` (PR3). Sent by the BFF after a policy
 * mutation lands so the daemon hosting the agent can drop its cached entry
 * and (when `policy` is embedded) install the fresh values without a
 * network round-trip.
 *
 * Wire-shape rationale: the design doc (§5) specifies `{agent_id, room_id?}`.
 * PR3 augments the payload with an optional `policy` blob so the daemon does
 * not need a separate signed-fetch endpoint to get the new values — the Hub
 * already holds the authoritative state, so it pushes the post-update view
 * inline. A daemon that doesn't recognize `policy` simply invalidates its
 * cache and falls back to the seed values from `provision_agent`.
 *
 * `room_id` is set when a per-room override is created/updated/cleared; it
 * targets the agent_id:room_id cache slot. When `room_id` is absent the
 * frame targets the agent's global cache slot. Per-room overrides survive
 * a global update (resolution is room-first with global as fallback), so a
 * global frame need not invalidate room entries — updating the global slot
 * automatically propagates to every room that still inherits.
 */
export interface PolicyUpdatedParams {
  agent_id: string;
  room_id?: string;
  policy?: {
    mode: "always" | "mention_only" | "keyword" | "muted";
    keywords: string[];
    /** Unix milliseconds; absent means no temporary mute. */
    muted_until?: number;
  };
}

/**
 * Identity metadata snapshot for one agent bound to the daemon. Used both
 * inside the `hello` frame `agents` array (full snapshot on connect) and as
 * the basis for the single-agent `update_agent` frame.
 *
 * `bio` is `null` when the dashboard cleared it, distinct from `undefined`
 * which means "no value sent" — daemon writes a placeholder for the former
 * and skips the field for the latter.
 */
export interface AgentIdentitySnapshot {
  agentId: string;
  displayName?: string;
  bio?: string | null;
  runtime?: string | null;
}

/**
 * Payload shape for the Hub-issued `hello` frame. The `server_time` field
 * is snake_case to match the Hub's pre-existing wire shape (every other
 * runtime/snapshot frame uses camelCase, but hello shipped first with
 * snake_case and renaming would break older daemons). `agents` was added
 * so the daemon can reconcile each provisioned agent's on-disk
 * `identity.md` against the dashboard-edited truth on every (re)connect.
 */
export interface HelloParams {
  server_time?: number;
  agents?: AgentIdentitySnapshot[];
}

/**
 * Payload shape for `update_agent`. Sent best-effort from the Hub right
 * after a dashboard PATCH, when the target daemon is currently online.
 * Offline daemons rely on the `hello.agents` snapshot for eventual
 * consistency, so this frame is fire-and-forget.
 */
export type UpdateAgentParams = AgentIdentitySnapshot;

/** Payload shape for `revoke_agent`. */
export interface RevokeAgentParams {
  agentId: string;
  /** When true, the credentials file on disk is deleted (default: true). */
  deleteCredentials?: boolean;
  /**
   * When true, the per-agent state directory (`~/.botcord/agents/{id}/state/`)
   * is removed after credentials cleanup. Default semantics = value of
   * `deleteCredentials` (default applied by the daemon, not here).
   */
  deleteState?: boolean;
  /**
   * When true, the per-agent workspace directory
   * (`~/.botcord/agents/{id}/workspace/`) is removed. Default false
   * (applied by the daemon). User-authored memory/notes are preserved
   * by default and require explicit opt-in to delete.
   */
  deleteWorkspace?: boolean;
}

/**
 * Result shape returned via `ControlAck.result` from a `revoke_agent`
 * frame. Each `*Deleted` flag reflects whether the corresponding disk
 * step actually completed — best-effort cleanup, so a `false` may mean
 * "not requested" or "failed and logged". See plan §11.3.
 */
export interface RevokeAgentResult {
  agentId: string;
  removed: boolean;
  credentialsDeleted: boolean;
  stateDeleted: boolean;
  workspaceDeleted: boolean;
}

/**
 * One probed AI-CLI runtime on the daemon host. Shared across the
 * `runtime_snapshot` push frame (daemon → Hub) and the `list_runtimes`
 * query ack (daemon → Hub in response to Hub → daemon).
 *
 * `available` is the single source of truth for "can the dashboard show
 * this runtime as an option?"; `version` / `path` are informational and
 * only populated when the adapter probe succeeds.
 */
export interface RuntimeProbeResult {
  /** Adapter id, e.g. `"claude-code"`, `"codex"`, `"gemini"`. */
  id: string;
  /** True when the adapter was located and probed successfully. */
  available: boolean;
  /** Adapter-reported version string, when the probe yielded one. */
  version?: string;
  /** Absolute path to the CLI binary, when known. */
  path?: string;
  /** Human-readable reason the probe failed (only when `available === false`). */
  error?: string;
  /**
   * Optional per-endpoint probe results. Populated by runtimes that talk to
   * external services (the openclaw-acp runtime uses one entry per
   * `DaemonConfig.openclawGateways` profile). Length is capped (32) by the
   * daemon before send and by the Hub on ingest. Older Hub builds that don't
   * recognize this field simply pass it through inside the opaque
   * `runtimes_json` blob.
   */
  endpoints?: RuntimeEndpointProbe[];
}

/**
 * One endpoint probe entry attached to a `RuntimeProbeResult`. For the
 * openclaw-acp runtime, each entry is a configured gateway profile and
 * carries the WS reachability outcome (L2) plus, when reachable, the list of
 * agent profiles available on that gateway (L3).
 */
export interface RuntimeEndpointProbe {
  /** Gateway profile name (`DaemonConfig.openclawGateways[].name`). */
  name: string;
  /** Endpoint URL (e.g. `wss://gw.example:18789`). */
  url: string;
  /** True when the gateway responded successfully within the timeout. */
  reachable: boolean;
  /** Gateway-reported version, when available. */
  version?: string;
  /** Failure reason when `reachable === false`. */
  error?: string;
  /**
   * Listing of agent profiles, only set when `reachable` and the listing RPC
   * (`agents.list`) succeeded. Shape mirrors OpenClaw's
   * `gateway/session-utils.ts` — `id` is the stable key (used by daemon
   * routes / `openclawAgent`), `name` is display-only.
   */
  agents?: Array<{
    id: string;
    name?: string;
    workspace?: string;
    model?: { name?: string; provider?: string };
  }>;
}

/**
 * Payload shape for `runtime_snapshot` (daemon → Hub event frame).
 *
 * `probedAt` is the daemon-side wall-clock time (unix millis) at which
 * the probe completed — Hub persists it verbatim so the dashboard can
 * show "runtimes last detected at <time>" for offline daemons too.
 */
export interface RuntimeSnapshotParams {
  runtimes: RuntimeProbeResult[];
  probedAt: number;
}

/**
 * Result envelope returned in the ack of a `list_runtimes` frame. The
 * handler re-probes synchronously and returns the fresh result; Hub may
 * use the same structure to update its cached `runtimes_json` without
 * waiting for the next push.
 */
export interface ListRuntimesResult {
  runtimes: RuntimeProbeResult[];
  probedAt: number;
}
