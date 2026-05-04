import type { GatewayLogger } from "./log.js";

// ---------------------------------------------------------------------------
// Routing (§9)
// ---------------------------------------------------------------------------

/** Set of predicates matched against a normalized inbound message to pick a route. */
export interface RouteMatch {
  channel?: string;
  accountId?: string;
  conversationId?: string;
  conversationPrefix?: string;
  conversationKind?: "direct" | "group";
  senderId?: string;
  mentioned?: boolean;
}

/** Concurrency model for turns sharing the same queue key. */
export type QueueMode = "serial" | "cancel-previous";

/** Source-based trust tier used by runtimes to pick default permission flags. */
export type TrustLevel = "owner" | "trusted" | "public";

/**
 * Resolved OpenClaw gateway endpoint for a route. Built eagerly in
 * `toGatewayConfig` from the `DaemonConfig.openclawGateways` registry plus the
 * `RouteRule.gateway` / `openclawAgent` choice — the dispatcher never needs
 * to re-query the registry. `name` is preserved purely for logging/snapshot.
 */
export interface ResolvedOpenclawGateway {
  name: string;
  url: string;
  token?: string;
  /** OpenClaw agent profile, with the route override already applied. */
  openclawAgent?: string;
}

/** Declarative route entry selecting the runtime and execution flags for matched messages. */
export interface GatewayRoute {
  match?: RouteMatch;
  runtime: string;
  cwd: string;
  extraArgs?: string[];
  queueMode?: QueueMode;
  trustLevel?: TrustLevel;
  /** Required when `runtime === "openclaw-acp"`. Resolved at config-load time. */
  gateway?: ResolvedOpenclawGateway;
  /**
   * Hermes profile name to attach to. Set when `runtime === "hermes-agent"`
   * and the agent is bound to a specific `~/.hermes/profiles/<name>/`. The
   * dispatcher forwards this to the adapter as
   * {@link RuntimeRunOptions.hermesProfile}, which is what the adapter uses
   * to switch `HERMES_HOME` at spawn time.
   */
  hermesProfile?: string;
}

// ---------------------------------------------------------------------------
// Config (§8)
// ---------------------------------------------------------------------------

/**
 * Per-channel configuration entry. Channel-specific extras (e.g. BotCord
 * `agentId`) are accepted via the index signature so adapters can read them
 * without introducing a tagged-union everywhere.
 */
export interface GatewayChannelConfig {
  id: string;
  type: string;
  accountId: string;
  [key: string]: unknown;
}

/** Root gateway configuration document loaded from disk or assembled in memory. */
export interface GatewayConfig {
  channels: GatewayChannelConfig[];
  defaultRoute: GatewayRoute;
  routes?: GatewayRoute[];
  /**
   * Daemon-synthesized per-agent routes. Snapshot/debug-only surface —
   * `resolveRoute` reads the live map on the Gateway, not this array.
   * Matched after `routes[]` and before `defaultRoute`.
   */
  managedRoutes?: GatewayRoute[];
  streamBlocks?: boolean;
}

// ---------------------------------------------------------------------------
// Inbound / outbound message shape (§7.3, §7.4, §7.5)
// ---------------------------------------------------------------------------

/** Normalized inbound message produced by a channel adapter for the dispatcher. */
export interface GatewayInboundMessage {
  id: string;
  /** Channel adapter id (`ChannelAdapter.id`), not channel type. */
  channel: string;
  accountId: string;
  conversation: {
    id: string;
    kind: "direct" | "group";
    title?: string;
    threadId?: string | null;
  };
  sender: {
    id: string;
    name?: string;
    kind: "user" | "agent" | "system";
  };
  text?: string;
  raw: unknown;
  replyTo?: string | null;
  mentioned?: boolean;
  receivedAt: number;
  trace?: {
    id: string;
    streamable?: boolean;
  };
}

/** Inbound envelope wrapping a normalized message with optional upstream ack callbacks. */
export interface GatewayInboundEnvelope {
  message: GatewayInboundMessage;
  ack?: {
    accept(): Promise<void>;
    reject?(reason: string): Promise<void>;
  };
}

/**
 * Channel-agnostic hook that produces a system-context string for a turn.
 * Called before every `runtime.run(...)`; returned value is passed through
 * as `RuntimeRunOptions.systemContext`. Runtimes surface it via
 * `--append-system-prompt` (Claude Code) or an equivalent prefix.
 *
 * Returning `undefined` or an empty string means "no context for this turn".
 * Builders must be resilient — if this throws, the dispatcher logs a warning
 * and continues the turn without systemContext rather than dropping the turn.
 */
export type SystemContextBuilder = (
  message: GatewayInboundMessage,
) => Promise<string | undefined> | string | undefined;

/**
 * Optional side-effect hook invoked right after the dispatcher acks an
 * envelope, before the turn executes. Intended for bookkeeping such as
 * activity tracking; errors are caught and logged so they do not break the
 * turn. Kept synchronous-or-async to match `SystemContextBuilder` ergonomics.
 */
export type InboundObserver = (
  message: GatewayInboundMessage,
) => Promise<void> | void;

/**
 * Channel-agnostic hook that composes the user-turn text passed to the
 * runtime. When omitted, the dispatcher passes `message.text.trim()` through
 * as-is. Builders can wrap the content with sender metadata, room headers,
 * reply hints, etc. — anything that should land in the session transcript.
 *
 * Must be synchronous + cheap (runs on the turn's critical path). Throws are
 * caught by the dispatcher and the raw trimmed text is used as a fallback so
 * a buggy composer never drops turns.
 */
export type UserTurnBuilder = (message: GatewayInboundMessage) => string;

/**
 * Optional hook fired after the dispatcher dispatches a reply to a channel.
 * Intended for outbound bookkeeping (loop-risk tracking, metrics). Errors
 * are caught and logged so observer failures never break the turn.
 */
export type OutboundObserver = (
  message: GatewayOutboundMessage,
) => Promise<void> | void;

/** Outbound reply payload passed to `ChannelAdapter.send()`. */
export interface GatewayOutboundMessage {
  channel: string;
  accountId: string;
  conversationId: string;
  threadId?: string | null;
  text: string;
  replyTo?: string | null;
  traceId?: string | null;
}

// ---------------------------------------------------------------------------
// Status (§14)
// ---------------------------------------------------------------------------

/** Per-channel status snapshot exposed for `status`/`doctor` style output. */
export interface ChannelStatusSnapshot {
  channel: string;
  accountId: string;
  running: boolean;
  connected?: boolean;
  restartPending?: boolean;
  reconnectAttempts?: number;
  lastStartAt?: number;
  lastStopAt?: number;
  lastError?: string | null;
  /** Third-party provider id when this channel is not the built-in BotCord. */
  provider?: "wechat" | "telegram";
  /** Last time the adapter polled the upstream provider (ms epoch). */
  lastPollAt?: number;
  /** Last time the adapter accepted an inbound message (ms epoch). */
  lastInboundAt?: number;
  /** Last time the adapter successfully sent a reply (ms epoch). */
  lastSendAt?: number;
  /** Whether the adapter currently holds a usable provider credential. */
  authorized?: boolean;
}

/** Per-turn status snapshot describing a currently-executing runtime invocation. */
export interface TurnStatusSnapshot {
  key: string;
  channel: string;
  accountId: string;
  conversationId: string;
  runtime: string;
  cwd: string;
  startedAt: number;
}

/** Aggregate gateway state combining channel and turn snapshots. */
export interface GatewayRuntimeSnapshot {
  channels: Record<string, ChannelStatusSnapshot>;
  turns: Record<string, TurnStatusSnapshot>;
}

// ---------------------------------------------------------------------------
// Channel adapter (§7.1–7.3, §13, §14)
// ---------------------------------------------------------------------------

/** Context passed to `ChannelAdapter.start()` for its lifetime. */
export interface ChannelStartContext {
  config: GatewayConfig;
  accountId: string;
  abortSignal: AbortSignal;
  log: GatewayLogger;
  emit: (event: GatewayInboundEnvelope) => Promise<void>;
  setStatus: (patch: Partial<ChannelStatusSnapshot>) => void;
}

/** Context passed to `ChannelAdapter.stop()` when the manager is tearing the channel down. */
export interface ChannelStopContext {
  reason?: string;
}

/** Context passed to `ChannelAdapter.send()` when delivering a reply. */
export interface ChannelSendContext {
  message: GatewayOutboundMessage;
  log: GatewayLogger;
}

/** Result returned by `ChannelAdapter.send()` — the upstream message id if known. */
export interface ChannelSendResult {
  providerMessageId?: string | null;
}

/** Context passed to `ChannelAdapter.streamBlock()` for progressive output forwarding. */
export interface ChannelStreamBlockContext {
  traceId: string;
  accountId: string;
  conversationId: string;
  block: unknown;
  log: GatewayLogger;
}

/**
 * Context passed to `ChannelAdapter.typing()` when the dispatcher signals
 * "agent has accepted this turn but no execution block has surfaced yet".
 * Adapters that bridge to a presence-style API (BotCord `/hub/typing`, etc.)
 * map this into a one-shot ephemeral notification.
 */
export interface ChannelTypingContext {
  traceId: string;
  accountId: string;
  conversationId: string;
  log: GatewayLogger;
}

/** Upstream messaging surface such as BotCord, Telegram, or WeChat. */
export interface ChannelAdapter {
  readonly id: string;
  readonly type: string;
  start(ctx: ChannelStartContext): Promise<unknown>;
  stop?(ctx: ChannelStopContext): Promise<void>;
  send(ctx: ChannelSendContext): Promise<ChannelSendResult>;
  status?(): ChannelStatusSnapshot;
  streamBlock?(ctx: ChannelStreamBlockContext): Promise<void>;
  /**
   * Optional ephemeral "agent is responding" hint. Fire-and-forget; failures
   * must not break the turn. Channels without a presence concept should leave
   * this undefined.
   */
  typing?(ctx: ChannelTypingContext): Promise<void>;
}

// ---------------------------------------------------------------------------
// Runtime adapter (§7.6)
// ---------------------------------------------------------------------------

/** One parsed block from a runtime's streaming output, forwarded via `onBlock`. */
export interface StreamBlock {
  /** Raw JSON object as emitted by the underlying CLI (e.g. claude-code stream-json). */
  raw: unknown;
  /**
   * Normalized kind, used by channels to decide whether to forward progressive
   * output. `thinking` is synthesized by the dispatcher (or emitted explicitly
   * by an adapter) to represent "the runtime is busy but has nothing visible
   * to show yet" — see `RuntimeStatusEvent`.
   */
  kind: "assistant_text" | "tool_use" | "tool_result" | "system" | "thinking" | "other";
  /** 1-based sequence number within this turn. */
  seq: number;
}

/**
 * Lightweight lifecycle event emitted by runtime adapters and consumed by the
 * dispatcher to drive Dashboard-side `typing` / `thinking` UI states. Not
 * exposed to channels directly — the dispatcher decides how to forward.
 *
 *   - `typing`   — ephemeral presence; dispatcher pings the channel's
 *                  `typing()` API on `started`. `stopped` is observed for
 *                  internal bookkeeping but not forwarded (frontend clears on
 *                  stream/message arrival).
 *   - `thinking` — trace-bound execution state; dispatcher converts each
 *                  event into a `kind: "thinking"` stream block.
 */
export type RuntimeStatusEvent =
  | { kind: "typing"; phase: "started" | "stopped" }
  | {
      kind: "thinking";
      phase: "started" | "updated" | "stopped";
      label?: string;
      raw?: unknown;
    };

/** Options passed to a runtime adapter for a single turn. */
export interface RuntimeRunOptions {
  text: string;
  /** Runtime-native session id for resume; null/empty for a new session. */
  sessionId: string | null;
  cwd: string;
  /**
   * Owning agent id (the daemon's `accountId` for this route). Lets adapters
   * resolve per-agent state — e.g. the codex adapter uses it to locate the
   * per-agent `CODEX_HOME` carrying the AGENTS.md that injects systemContext.
   */
  accountId: string;
  /**
   * Hub URL the owning agent is registered against. Forwarded to runtimes
   * so spawned CLI subprocesses can target the correct hub via
   * `BOTCORD_HUB` (see `cli-resolver.buildCliEnv`). Optional because the
   * dispatcher cannot always resolve a per-agent hub (e.g. for agents
   * provisioned after boot); when unset, runtimes leave `BOTCORD_HUB`
   * unspecified and the bundled CLI falls back to its own default.
   */
  hubUrl?: string;
  signal: AbortSignal;
  extraArgs?: string[];
  trustLevel: TrustLevel;
  /** System-level context injected alongside the user turn (memory, digest, room info). */
  systemContext?: string;
  /** Channel-agnostic bag for dispatch-time data (traceId, channel, conversation, etc.). */
  context?: Record<string, unknown>;
  /** Called for every parsed block while the turn is in progress. */
  onBlock?: (block: StreamBlock) => void;
  /**
   * Optional lifecycle hook for `typing` / `thinking` status. Adapters that
   * can identify session/turn/tool transitions before any `StreamBlock` is
   * available should emit through here so the dispatcher can drive
   * Dashboard-side state. Errors from this callback must be swallowed
   * by the adapter — the dispatcher's handler is fire-and-forget.
   */
  onStatus?: (event: RuntimeStatusEvent) => void;
  /**
   * External service endpoint required by some runtimes (first user:
   * openclaw-acp). Resolved at config-load time and passed through here per
   * call — runtime factories do not see it. Mirrors the `hubUrl` precedent of
   * lifting service URLs out of `extraArgs` into typed first-class fields.
   */
  gateway?: ResolvedOpenclawGateway;
  /**
   * Hermes profile to attach to. Only meaningful when `runtime ===
   * "hermes-agent"`. When set, the adapter switches
   * `HERMES_HOME=~/.hermes/profiles/<name>/` (or `~/.hermes` for `default`)
   * so the BotCord agent shares state.db / sessions / skills with the
   * user's command-line `hermes`. Mirrors how `gateway` is lifted out of
   * `extraArgs` for the openclaw-acp runtime.
   */
  hermesProfile?: string;
}

/** Result returned by a runtime adapter after a turn completes. */
export interface RuntimeRunResult {
  /** Final assistant text for this turn (concatenated if streamed). */
  text: string;
  /** New runtime session id to persist so the next turn can resume. */
  newSessionId: string;
  /** Optional cost in USD, if the runtime reports it. */
  costUsd?: number;
  /** Populated when the runtime reported a hard error. */
  error?: string;
}

/** Detection result for whether a runtime binary/SDK is usable on this machine. */
export interface RuntimeProbeResult {
  available: boolean;
  path?: string;
  version?: string;
}

/** Downstream agent executor such as Claude Code, Codex, Gemini, or OpenClaw. */
export interface RuntimeAdapter {
  readonly id: string;
  run(opts: RuntimeRunOptions): Promise<RuntimeRunResult>;
  probe?(): RuntimeProbeResult;
}

// ---------------------------------------------------------------------------
// Session store (§10)
// ---------------------------------------------------------------------------

/** Minimal fields needed to derive a session key for the JSON session store. */
export interface SessionKeyInput {
  runtime: string;
  channel: string;
  accountId: string;
  conversationKind: "direct" | "group";
  conversationId: string;
  threadId?: string | null;
}

/** Persisted runtime-session record keyed by the derived session key. */
export interface GatewaySessionEntry {
  key: string;
  runtime: string;
  runtimeSessionId: string;
  channel: string;
  accountId: string;
  conversationKind: "direct" | "group";
  conversationId: string;
  threadId?: string | null;
  cwd: string;
  updatedAt: number;
}
