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
   * on both sides. See `docs/agent-runtime-property-plan.md`.
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
  };
}

/** Payload shape for `revoke_agent`. */
export interface RevokeAgentParams {
  agentId: string;
  /** When true, the credentials file on disk is deleted (default: true). */
  deleteCredentials?: boolean;
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
