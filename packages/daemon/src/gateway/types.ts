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

/** Declarative route entry selecting the runtime and execution flags for matched messages. */
export interface GatewayRoute {
  match?: RouteMatch;
  runtime: string;
  cwd: string;
  extraArgs?: string[];
  queueMode?: QueueMode;
  trustLevel?: TrustLevel;
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

/** Upstream messaging surface such as BotCord, Telegram, or WeChat. */
export interface ChannelAdapter {
  readonly id: string;
  readonly type: string;
  start(ctx: ChannelStartContext): Promise<unknown>;
  stop?(ctx: ChannelStopContext): Promise<void>;
  send(ctx: ChannelSendContext): Promise<ChannelSendResult>;
  status?(): ChannelStatusSnapshot;
  streamBlock?(ctx: ChannelStreamBlockContext): Promise<void>;
}

// ---------------------------------------------------------------------------
// Runtime adapter (§7.6)
// ---------------------------------------------------------------------------

/** One parsed block from a runtime's streaming output, forwarded via `onBlock`. */
export interface StreamBlock {
  /** Raw JSON object as emitted by the underlying CLI (e.g. claude-code stream-json). */
  raw: unknown;
  /** Normalized kind, used by channels to decide whether to forward progressive output. */
  kind: "assistant_text" | "tool_use" | "tool_result" | "system" | "other";
  /** 1-based sequence number within this turn. */
  seq: number;
}

/** Options passed to a runtime adapter for a single turn. */
export interface RuntimeRunOptions {
  text: string;
  /** Runtime-native session id for resume; null/empty for a new session. */
  sessionId: string | null;
  cwd: string;
  signal: AbortSignal;
  extraArgs?: string[];
  trustLevel: TrustLevel;
  /** System-level context injected alongside the user turn (memory, digest, room info). */
  systemContext?: string;
  /** Channel-agnostic bag for dispatch-time data (traceId, channel, conversation, etc.). */
  context?: Record<string, unknown>;
  /** Called for every parsed block while the turn is in progress. */
  onBlock?: (block: StreamBlock) => void;
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
