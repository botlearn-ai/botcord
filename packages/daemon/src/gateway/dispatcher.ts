import { randomUUID } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import path from "node:path";

import type { GatewayLogger } from "./log.js";
import { looksLikeRuntimeAuthFailure } from "./runtime-errors.js";
import { resolveRoute } from "./router.js";
import { sessionKey, type SessionStore } from "./session-store.js";
import {
  truncateTextField,
  type DeliveryStatus,
  type TranscriptBlockSummary,
  type TranscriptWriter,
} from "./transcript.js";
import type {
  ChannelAdapter,
  GatewayConfig,
  GatewayInboundEnvelope,
  GatewayInboundMessage,
  GatewayOutboundMessage,
  GatewayRoute,
  GatewaySessionEntry,
  InboundObserver,
  MemoryContextBuilder,
  OutboundObserver,
  QueueMode,
  RuntimeAdapter,
  RuntimeRecoveryContextBuilder,
  RuntimeRunResult,
  RuntimeCircuitBreakerSnapshot,
  RuntimeStatusEvent,
  StreamBlock,
  SystemContextBuilder,
  TurnStatusSnapshot,
  UserTurnBuilder,
} from "./types.js";

const DEFAULT_TURN_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_RUNTIME_AUTH_FAILURE_THRESHOLD = 3;
const DEFAULT_RUNTIME_AUTH_FAILURE_COOLDOWN_MS = 10 * 60 * 1000;

/**
 * Owner-chat room prefix. Reply-text gating: only rooms with this prefix get
 * `result.text` forwarded to the channel; in every other room the runtime's
 * plain text output is discarded — agents must use the `botcord_send` tool
 * (or `botcord send` CLI via Bash) to actually deliver replies.
 */
const OWNER_CHAT_ROOM_PREFIX = "rm_oc_";
const TRANSCRIPT_BLOCK_RAW_LIMIT = 16 * 1024;
const SECRET_KEY_RE = /token|secret|private.?key|api.?key|authorization|password/i;

/** Maximum number of buffered serial entries per queue. Excess entries drop oldest. */
const MAX_BATCH_BUFFER_ENTRIES = 40;

/**
 * Soft cap on the total characters across raw.batch members in a merged
 * turn. When exceeded, oldest entries are dropped (with a warn log) so the
 * runtime prompt stays bounded even if the channel-side batch was huge.
 */
const MAX_BATCH_BUFFER_CHARS = 16000;

/**
 * Per-(accountId, conversationId) cooldown between successive `/hub/typing`
 * pings. Hub rate-limits to 20 typing/min per agent (backend hub.py:1675);
 * cancel-previous bursts on a fast user can otherwise trip 429 silently.
 */
const TYPING_DEBOUNCE_MS = 2000;

/**
 * Most provider typing APIs are short-lived one-shots. Telegram's
 * `sendChatAction(typing)`, for example, must be refreshed while the runtime
 * is still working or the visible typing indicator disappears before the
 * reply lands.
 */
const TYPING_REFRESH_MS = 4000;

/** LRU cap on the typing-recency map so long-running daemons don't grow unbounded. */
const TYPING_RECENCY_CAP = 1024;
const AUTO_ATTACHMENT_LIMIT = 10;
const AUTO_ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;
const AUTO_ATTACHMENT_EXTENSIONS = new Set([
  ".avif",
  ".bmp",
  ".csv",
  ".doc",
  ".docx",
  ".gif",
  ".htm",
  ".html",
  ".jpeg",
  ".jpg",
  ".pdf",
  ".png",
  ".ppt",
  ".pptx",
  ".svg",
  ".webp",
  ".xls",
  ".xlsx",
  ".zip",
]);
const REPLY_LOCAL_PATH_RE =
  /(^|[\s([{"'`])((?:\/|\.{1,2}\/)?(?:[\w@+.-]+\/)+[\w@+.-]+\.(?:avif|bmp|csv|docx?|gif|html?|jpe?g|pdf|png|pptx?|svg|webp|xlsx?|zip))(?=$|[\s)\]}"'`,.!?:;])/gi;

function transcriptBlocksVerbose(): boolean {
  return process.env.BOTCORD_TRANSCRIPT_BLOCKS === "verbose" ||
    process.env.BOTCORD_TRACE_VERBOSE === "1";
}

function buildMemoryUpdateNotice(args: {
  previousVersion: string | null;
  currentVersion: string;
  userTurn: string;
}): string {
  return [
    "[BotCord Memory Update Notice]",
    `The persistent working memory changed since this runtime session last used it (previous: ${args.previousVersion ?? "none"}, current: ${args.currentVersion}).`,
    "Before acting on the message below, retrieve the latest working memory through the available BotCord memory tool or CLI, then treat that latest memory as authoritative.",
    "If using the local daemon CLI, run: botcord-daemon memory get",
    "The latest memory supersedes older goals, monitoring rules, preferences, and task state in the resumed conversation.",
    "",
    "[Current Message]",
    args.userTurn,
  ].join("\n");
}

function summarizeStreamBlock(block: StreamBlock): TranscriptBlockSummary {
  const summary: TranscriptBlockSummary = { type: block.kind };
  const raw = block.raw as {
    text?: unknown;
    name?: unknown;
    update?: unknown;
    params?: { update?: unknown };
  } | null | undefined;
  if (raw && typeof raw === "object") {
    if (typeof raw.text === "string") summary.chars = raw.text.length;
    if (typeof raw.name === "string") summary.name = raw.name;
    const update = raw.params?.update ?? raw.update;
    if (update && typeof update === "object") {
      const u = update as Record<string, unknown>;
      if (typeof u.sessionUpdate === "string" && !summary.name) summary.name = u.sessionUpdate;
      const toolCall = u.toolCall;
      if (toolCall && typeof toolCall === "object") {
        const toolName = (toolCall as Record<string, unknown>).name;
        if (typeof toolName === "string") summary.name = toolName;
      }
    }
  }
  return summary;
}

function redactAndCap(value: unknown, budget = TRANSCRIPT_BLOCK_RAW_LIMIT): unknown {
  const seen = new WeakSet<object>();
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") {
      return redactSecretString(v.length > budget ? `${v.slice(0, budget)}…` : v);
    }
    if (Array.isArray(v)) return v.slice(0, 50).map(walk);
    if (!v || typeof v !== "object") return v;
    if (seen.has(v)) return "[Circular]";
    seen.add(v);
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(v as Record<string, unknown>).slice(0, 80)) {
      out[key] = SECRET_KEY_RE.test(key) ? "[REDACTED]" : walk(child);
    }
    return out;
  };
  return walk(value);
}

function redactSecretString(value: string): string {
  return value
    .replace(/(Authorization:\s*Bearer\s+)[^\s"']+/gi, "$1[REDACTED]")
    .replace(/\b(token=)[^\s"']+/gi, "$1[REDACTED]")
    .replace(/\b(drt_|dit_|gho_)[A-Za-z0-9_-]+/g, "$1[REDACTED]");
}

function extractCloudRunBudget(msg: GatewayInboundMessage): CloudRunBudgetCaps | undefined {
  const envelope = (msg.raw as { envelope?: unknown } | undefined)?.envelope as
    | {
        type?: unknown;
        payload?: {
          cloud_run?: {
            budget?: {
              max_wall_time_seconds?: unknown;
              max_tool_calls?: unknown;
            } | null;
          } | null;
        } | null;
      }
    | undefined;
  if (envelope?.type !== "cloud_run") return undefined;
  const budget = envelope.payload?.cloud_run?.budget;
  if (!budget) return undefined;
  const out: CloudRunBudgetCaps = {};
  if (
    typeof budget.max_wall_time_seconds === "number" &&
    Number.isFinite(budget.max_wall_time_seconds) &&
    budget.max_wall_time_seconds > 0
  ) {
    out.maxWallTimeMs = Math.floor(budget.max_wall_time_seconds * 1000);
  }
  if (
    typeof budget.max_tool_calls === "number" &&
    Number.isFinite(budget.max_tool_calls) &&
    budget.max_tool_calls > 0
  ) {
    out.maxToolCalls = Math.floor(budget.max_tool_calls);
  }
  return out.maxWallTimeMs !== undefined || out.maxToolCalls !== undefined ? out : undefined;
}

function looksLikeRecoverableSessionFailure(error: string): boolean {
  return /compact|compaction|context|token limit|maximum context|too many tokens|conversation found|session .*not found|resume/i
    .test(error);
}

function buildRuntimeRecoveryPrompt(args: {
  userTurn: string;
  error: string;
  recoveryContext?: string | null;
}): string {
  return [
    "[BotCord Runtime Recovery Notice]",
    "The previous Codex runtime session for this room became unrecoverable while resuming or compacting context.",
    `Previous runtime error: ${truncate(args.error, 1000)}`,
    "You are now running in a fresh Codex session.",
    "Use the recent room messages below, current filesystem state, and available BotCord memory/context tools to reconstruct the active task.",
    "Continue the original user request without asking the user to repeat information unless it is missing from those sources.",
    "",
    args.recoveryContext?.trim() || "[Recent Room Messages]\n(unavailable)",
    "",
    "[Current User Turn]",
    args.userTurn,
  ].join("\n");
}

/**
 * Pick the canonical reply_to value to attach to outbound replies for a given
 * inbound `GatewayInboundMessage`. Priority:
 *
 *   1. `msg.replyTo` — the inbound was itself a reply; preserve the chain so
 *      receipts and threaded replies point at the original target.
 *   2. `raw.envelope.msg_id` — the wire-protocol identifier (UUID per a2a/0.1).
 *      This is the canonical form the hub stores in `reply_to_msg_id`.
 *   3. `msg.id` — fallback to the hub_msg_id (`h_*`) the BotCord channel
 *      stamps on every inbound. The hub accepts this form via
 *      `_load_reply_target`'s prefix-based discriminator, but emitting it is
 *      lossy because the hub then has to resolve it back to msg_id.
 *
 * Exported for unit testing; production code paths use Dispatcher.providerReplyTo.
 */
export function pickReplyToTarget(msg: GatewayInboundMessage): string {
  if (msg.replyTo) return msg.replyTo;
  const raw = msg.raw as { envelope?: { msg_id?: unknown } } | null | undefined;
  const envMsgId =
    raw && typeof raw.envelope?.msg_id === "string" && raw.envelope.msg_id
      ? raw.envelope.msg_id
      : null;
  return envMsgId ?? msg.id;
}

/** Factory signature for building a runtime adapter at turn dispatch time. */
export type RuntimeFactory = (
  runtimeId: string,
  extraArgs?: string[],
) => RuntimeAdapter;

/** Constructor options for `Dispatcher`. */
export interface DispatcherOptions {
  config: GatewayConfig;
  channels: Map<string, ChannelAdapter>;
  runtime: RuntimeFactory;
  sessionStore: SessionStore;
  log: GatewayLogger;
  turnTimeoutMs?: number;
  runtimeAuthFailureThreshold?: number;
  runtimeAuthFailureCooldownMs?: number;
  /**
   * Live reference to the Gateway's managed-route map. Dispatcher reads
   * `values()` on every `resolveRoute` call so hot-add/remove take effect
   * without restart.
   */
  managedRoutes?: Map<string, GatewayRoute>;
  /**
   * Optional hook producing a `systemContext` string for each turn. Result is
   * forwarded to the runtime as `RuntimeRunOptions.systemContext`. Errors are
   * swallowed and logged — they never abort the turn.
   */
  buildSystemContext?: SystemContextBuilder;
  /**
   * Optional hook returning the current working-memory snapshot/version. When
   * a resumed runtime session last saw a different version, dispatcher injects
   * the snapshot into the actual user prompt so resumed transcripts cannot
   * keep following stale memory.
   */
  buildMemoryContext?: MemoryContextBuilder;
  /**
   * Optional hook that returns recent room context for a fresh-session retry
   * after a runtime resume session becomes unrecoverable.
   */
  buildRuntimeRecoveryContext?: RuntimeRecoveryContextBuilder;
  /**
   * Optional side-effect hook invoked after ack, before the turn runs.
   * Intended for bookkeeping (e.g. activity tracking). Errors are logged
   * and suppressed so the turn is never cancelled by observer failure.
   */
  onInbound?: InboundObserver;
  /**
   * Optional composer that wraps `message.text` with channel-specific
   * metadata (sender label, room header, reply hints…) before it is handed
   * to the runtime. Skipped if it throws — the raw trimmed text is used as
   * a fallback so a buggy composer cannot drop turns.
   */
  composeUserTurn?: UserTurnBuilder;
  /**
   * Optional observer fired after each reply is dispatched. Intended for
   * outbound bookkeeping such as loop-risk tracking. Errors are logged
   * and suppressed so observer failures never break the turn.
   */
  onOutbound?: OutboundObserver;
  onRuntimeCircuitBreakerChange?: () => void;
  /**
   * Optional observer fired exactly once per turn after ``runtime.run``
   * resolves (or throws / times out). Receives the inbound message, the
   * raw runtime result (may be undefined on throw), the elapsed wall
   * time in milliseconds, and any thrown error. The cloud daemon hooks
   * this to settle ``cloud_run`` envelopes against the Hub's usage
   * ledger; local daemons leave it unset.
   *
   * Errors thrown by the observer are logged and swallowed — settle
   * failures must never break the agent reply path.
   */
  onTurnComplete?: (event: {
    message: GatewayInboundMessage;
    result?: RuntimeRunResult;
    wallTimeMs: number;
    error?: unknown;
  }) => Promise<void> | void;
  /**
   * Optional attention gate (PR3, design §4.2). Resolved AFTER `onInbound`
   * runs and BEFORE the runtime turn enqueues, so working memory / activity
   * tracking still observe the message even when the gate skips the wake.
   *
   * Return `true` to wake the runtime, `false` to skip the turn. Errors are
   * logged and treated as `true` (fail-open) so a buggy gate cannot silence
   * the agent.
   */
  attentionGate?: (
    message: GatewayInboundMessage,
  ) => Promise<boolean> | boolean;
  /**
   * Resolve the hub URL the inbound message's agent is registered against.
   * Threaded into `RuntimeRunOptions.hubUrl` so spawned CLI subprocesses
   * target the correct hub. If unset, runtimes leave `BOTCORD_HUB`
   * unspecified and fall back to whatever the bundled CLI defaults to.
   */
  resolveHubUrl?: (accountId: string) => string | undefined;
  /**
   * Optional NDJSON transcript writer. When provided, dispatcher emits one
   * inbound record + one path record + (for dispatched turns) one terminal
   * record per `handle()` call. A noop writer is used by default so existing
   * call sites keep working unchanged. See `docs/transcript-logging.md`.
   */
  transcript?: TranscriptWriter;
}

/**
 * Reason carried on `AbortController.abort()` when a cancel-previous wave
 * is taking over the slot. Distinguishing this from a timeout abort lets
 * `runTurn`'s finalize know NOT to write a `turn_error` — the supersede
 * path already wrote a `dropped` record for the old turnId before the abort.
 */
class TurnSupersededError extends Error {
  constructor(public readonly supersededBy: string) {
    super("turn superseded");
    this.name = "TurnSupersededError";
  }
}

const NOOP_TRANSCRIPT: TranscriptWriter = {
  enabled: false,
  rootDir: "",
  write: () => {},
};

interface TurnSlot {
  turnId: string;
  controller: AbortController;
  timedOut: boolean;
  budgetExceeded: string | null;
  snapshot: TurnStatusSnapshot;
  done: Promise<void>;
  dispatchedAt: number;
  /** Streamed block summaries flushed into the terminal `outbound` record. */
  blocks: TranscriptBlockSummary[];
}

/**
 * One entry buffered for serial-mode coalescing. Each successful `runSerial`
 * call pushes one entry; the worker drains the entire buffer on the next
 * turn boundary and merges them into a single dispatch.
 */
interface BufferedSerialEntry {
  route: GatewayRoute;
  msg: GatewayInboundEnvelope["message"];
  channel: ChannelAdapter;
  /** Per-arrival turnId; preserved through merge so transcript can record dropped/dispatched correctly. */
  turnId: string;
}

interface QueueState {
  /** The currently executing turn on this queue key, if any. */
  current: TurnSlot | null;
  /**
   * Generation counter bumped every time a cancel-previous turn arrives.
   * Any in-flight cancel-previous arrival captures the value at entry; if a
   * newer arrival bumps the counter while it's still awaiting the prior
   * turn's teardown, the older one observes the mismatch and drops out. This
   * closes the race where two cancel-previous calls could both observe
   * `current === null` after an abort and run concurrently.
   */
  cancelGen: number;
  /**
   * Serial-mode coalescing buffer. Messages pushed here while a turn is in
   * flight are drained — and merged into a single user turn — on the next
   * iteration of the worker loop. First message in an idle queue triggers a
   * turn immediately; subsequent arrivals fold into the next batch.
   */
  serialBuffer: BufferedSerialEntry[];
  /** True when the serial-drain worker is actively running (or about to). */
  serialWorkerActive: boolean;
}

interface CloudRunBudgetCaps {
  maxWallTimeMs?: number;
  maxToolCalls?: number;
}

interface DeferredMultimodalEntry extends BufferedSerialEntry {
  queuedAt: number;
}

interface RuntimeAuthFailureState extends RuntimeCircuitBreakerSnapshot {}

/**
 * Gateway dispatcher: consumes `GatewayInboundEnvelope` and drives a runtime
 * turn per message, respecting queue mode, trust level, streaming, and
 * session persistence rules from the plan (§7/§9/§10/§11/§12/§13).
 *
 * Deliberate deviation from daemon: this core does NOT wrap inbound text in
 * BotCord-style XML envelopes for untrusted content. The channel adapter is
 * responsible for any channel-specific sanitization; the dispatcher passes
 * `message.text` through to the runtime as-is (plan §15).
 */
export class Dispatcher {
  private readonly config: GatewayConfig;
  private readonly channels: Map<string, ChannelAdapter>;
  private readonly runtimeFactory: RuntimeFactory;
  private readonly sessionStore: SessionStore;
  private readonly log: GatewayLogger;
  private readonly turnTimeoutMs: number;
  private readonly runtimeAuthFailureThreshold: number;
  private readonly runtimeAuthFailureCooldownMs: number;
  private readonly buildSystemContext?: SystemContextBuilder;
  private readonly buildMemoryContext?: MemoryContextBuilder;
  private readonly buildRuntimeRecoveryContext?: RuntimeRecoveryContextBuilder;
  private readonly onInbound?: InboundObserver;
  private readonly onOutbound?: OutboundObserver;
  private readonly onTurnComplete?: DispatcherOptions["onTurnComplete"];
  private readonly onRuntimeCircuitBreakerChange?: () => void;
  private readonly composeUserTurn?: UserTurnBuilder;
  private readonly managedRoutes?: Map<string, GatewayRoute>;
  private readonly attentionGate?: (
    message: GatewayInboundMessage,
  ) => Promise<boolean> | boolean;
  private readonly resolveHubUrl?: (accountId: string) => string | undefined;
  private readonly transcript: TranscriptWriter;
  private readonly queues: Map<string, QueueState> = new Map();
  private readonly deferredMultimodal: Map<string, DeferredMultimodalEntry[]> = new Map();
  private readonly runtimeAuthFailures: Map<string, RuntimeAuthFailureState> = new Map();
  /**
   * Last `/hub/typing` ping timestamp per (accountId, conversationId).
   * Used to debounce cancel-previous bursts so we don't trip Hub's 20/min
   * rate limit. True LRU (delete + set on access) capped at TYPING_RECENCY_CAP.
   */
  private readonly recentTypingPings: Map<string, number> = new Map();

  constructor(opts: DispatcherOptions) {
    this.config = opts.config;
    this.channels = opts.channels;
    this.runtimeFactory = opts.runtime;
    this.sessionStore = opts.sessionStore;
    this.log = opts.log;
    this.turnTimeoutMs = opts.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
    this.runtimeAuthFailureThreshold =
      opts.runtimeAuthFailureThreshold ?? DEFAULT_RUNTIME_AUTH_FAILURE_THRESHOLD;
    this.runtimeAuthFailureCooldownMs =
      opts.runtimeAuthFailureCooldownMs ?? DEFAULT_RUNTIME_AUTH_FAILURE_COOLDOWN_MS;
    this.buildSystemContext = opts.buildSystemContext;
    this.buildMemoryContext = opts.buildMemoryContext;
    this.buildRuntimeRecoveryContext = opts.buildRuntimeRecoveryContext;
    this.onInbound = opts.onInbound;
    this.onOutbound = opts.onOutbound;
    this.onTurnComplete = opts.onTurnComplete;
    this.onRuntimeCircuitBreakerChange = opts.onRuntimeCircuitBreakerChange;
    this.composeUserTurn = opts.composeUserTurn;
    this.managedRoutes = opts.managedRoutes;
    this.attentionGate = opts.attentionGate;
    this.resolveHubUrl = opts.resolveHubUrl;
    this.transcript = opts.transcript ?? NOOP_TRANSCRIPT;
  }

  /** Consume one inbound envelope, ack it once ownership is decided, then run its turn. */
  async handle(envelope: GatewayInboundEnvelope): Promise<void> {
    const msg = envelope.message;

    // ---- Pre-skip branches: NEVER write a transcript record (design §3.2).
    // Order matters: unknown channel → own echo → empty text. Each ack's the
    // envelope (when applicable) and returns silently with only a debug/warn
    // line in the daemon log.

    // Pre-skip: unknown channel — configuration error, not a conversation event.
    const channel = this.channels.get(msg.channel);
    if (!channel) {
      this.log.warn("dispatcher: unknown channel for outbound reply", {
        channel: msg.channel,
        messageId: msg.id,
      });
      await this.safeAck(envelope);
      return;
    }

    // Pre-skip: echo from the agent itself (own agent output looped back).
    // Owner/human messages in dashboard rooms share the agent's id as sender.id
    // but carry sender.kind === "user", so we only skip when kind === "agent".
    if (msg.sender.id === msg.accountId && msg.sender.kind === "agent") {
      this.log.debug("dispatcher skip: own message", { messageId: msg.id });
      await this.safeAck(envelope);
      return;
    }

    const managed = this.managedRoutes ? Array.from(this.managedRoutes.values()) : undefined;
    const route = resolveRoute(msg, this.config, managed);
    const mode = resolveQueueMode(route, msg.conversation.kind);
    const queueKey = buildQueueKey(msg);

    // Pre-skip: empty/whitespace text.
    const rawText = typeof msg.text === "string" ? msg.text.trim() : "";
    if (!rawText) {
      this.log.debug("dispatcher skip: empty text", { messageId: msg.id });
      await this.safeAck(envelope);
      return;
    }

    // From here on, the inbound is a real conversation event — generate a
    // turnId and write the inbound transcript record.
    const turnId = randomUUID();

    // Multimodal-only arrivals (files/images without sender-authored text)
    // should not wake the runtime on their own. Ack them, record the inbound
    // event, and prepend them to the next text-bearing turn for this queue.
    if (isMultimodalOnlyMessage(msg)) {
      await this.safeAck(envelope);
      this.emitInbound(turnId, msg);
      this.deferMultimodal(queueKey, { route, msg, channel, turnId, queuedAt: Date.now() });
      this.log.info("dispatcher: deferred multimodal-only inbound", {
        agentId: msg.accountId,
        roomId: msg.conversation.id,
        topicId: msg.conversation.threadId ?? null,
        turnId,
        messageId: msg.id,
        senderId: msg.sender.id,
        senderKind: msg.sender.kind,
        mode,
        queueKey,
      });
      if (this.onInbound) {
        try {
          await this.onInbound(msg);
        } catch (err) {
          this.log.warn("dispatcher: onInbound threw — continuing", {
            messageId: msg.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      return;
    }

    const deferred = this.takeDeferredMultimodal(queueKey);
    let dispatchMsg = msg;
    let dispatchTurnId: string = turnId;
    let dispatchRoute = route;
    let dispatchChannel = channel;
    let text = rawText;
    let mergedFromDeferredTurnIds: string[] = [];
    if (deferred.length > 0) {
      const merged = this.mergeSerialBuffer(
        [...deferred, { route, msg, channel, turnId }],
        queueKey,
      );
      if (merged) {
        dispatchMsg = merged.msg;
        dispatchTurnId = merged.turnId;
        dispatchRoute = merged.route;
        dispatchChannel = merged.channel;
        text = merged.text;
        mergedFromDeferredTurnIds = deferred.map((e) => e.turnId);
        for (const entry of deferred) {
          this.transcript.write({
            ts: nowIso(),
            kind: "dropped",
            turnId: entry.turnId,
            agentId: entry.msg.accountId,
            roomId: entry.msg.conversation.id,
            topicId: entry.msg.conversation.threadId ?? null,
            reason: "batch_merged",
            supersededBy: dispatchTurnId,
          });
        }
      }
    }

    // Compose the final user-turn text only for cancel-previous mode, where
    // the dispatcher consumes the pre-composed text directly. Serial mode
    // re-runs the composer at drain time on the merged message (so it sees
    // the full coalesced batch instead of any single arrival), so calling
    // the composer here would just be redundant work.
    let composeFailedError: string | undefined;
    if (mode === "cancel-previous" && this.composeUserTurn) {
      try {
        const composed = this.composeUserTurn(dispatchMsg);
        if (typeof composed === "string" && composed.length > 0) {
          text = composed;
        }
      } catch (err) {
        composeFailedError = err instanceof Error ? err.message : String(err);
        this.log.warn("dispatcher: composeUserTurn threw — using raw text", {
          messageId: dispatchMsg.id,
          error: composeFailedError,
        });
      }
    }

    // Ack immediately: once the dispatcher has a route + queue key, ownership is decided.
    await this.safeAck(envelope);

    // Inbound transcript record — always before observers / gates so we have a
    // grounded turnId for any downstream attention_skipped / dropped / etc.
    this.emitInbound(turnId, msg);

    this.log.info("dispatcher: inbound received", {
      agentId: msg.accountId,
      roomId: msg.conversation.id,
      topicId: msg.conversation.threadId ?? null,
      turnId,
      messageId: msg.id,
      senderId: msg.sender.id,
      senderKind: msg.sender.kind,
      mode,
      textPreview: logPreview(rawText),
    });

    // Notify the optional observer (activity tracking, metrics, etc.) as soon
    // as the dispatcher owns the message. Errors must not abort the turn.
    if (this.onInbound) {
      try {
        await this.onInbound(msg);
      } catch (err) {
        this.log.warn("dispatcher: onInbound threw — continuing", {
          messageId: msg.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Attention gate (PR3, design §4.2). Inserted AFTER `onInbound` so the
    // working-memory append + activity tracking still see the message — only
    // the runtime turn is suppressed. Errors are treated as wake (fail-open)
    // so a buggy gate cannot silence the agent.
    if (this.attentionGate) {
      let wake = true;
      try {
        const result = this.attentionGate(dispatchMsg);
        wake = result instanceof Promise ? await result : result;
      } catch (err) {
        this.log.warn("dispatcher: attentionGate threw — waking", {
          messageId: dispatchMsg.id,
          error: err instanceof Error ? err.message : String(err),
        });
        wake = true;
      }
      if (!wake) {
        this.log.debug("dispatcher skip turn: attention policy", {
          messageId: dispatchMsg.id,
          accountId: dispatchMsg.accountId,
          conversationId: dispatchMsg.conversation.id,
        });
        this.transcript.write({
          ts: nowIso(),
          kind: "attention_skipped",
          turnId: dispatchTurnId,
          agentId: dispatchMsg.accountId,
          roomId: dispatchMsg.conversation.id,
          topicId: dispatchMsg.conversation.threadId ?? null,
          reason: "attention_gate_false",
        });
        return;
      }
    }

    if (composeFailedError) {
      this.transcript.write({
        ts: nowIso(),
        kind: "compose_failed",
        turnId: dispatchTurnId,
        agentId: dispatchMsg.accountId,
        roomId: dispatchMsg.conversation.id,
        topicId: dispatchMsg.conversation.threadId ?? null,
        error: composeFailedError,
        fallback: "raw_text",
      });
    }

    const openAuthBreaker = this.openRuntimeAuthBreaker(dispatchRoute, dispatchMsg);
    if (openAuthBreaker) {
      await this.skipRuntimeForAuthBreaker(
        openAuthBreaker,
        dispatchRoute,
        dispatchMsg,
        dispatchChannel,
        dispatchTurnId,
      );
      return;
    }

    if (mode === "cancel-previous") {
      await this.runCancelPrevious(
        queueKey,
        dispatchRoute,
        text,
        dispatchMsg,
        dispatchChannel,
        dispatchTurnId,
        mergedFromDeferredTurnIds,
      );
    } else {
      await this.runSerial(
        queueKey,
        dispatchRoute,
        text,
        dispatchMsg,
        dispatchChannel,
        dispatchTurnId,
        mergedFromDeferredTurnIds,
      );
    }
  }

  /** Snapshot of currently running turns keyed by queue key. */
  turns(): Record<string, TurnStatusSnapshot> {
    const out: Record<string, TurnStatusSnapshot> = {};
    for (const [key, q] of this.queues) {
      if (q.current) out[key] = { ...q.current.snapshot };
    }
    return out;
  }

  runtimeCircuitBreakers(): Record<string, RuntimeCircuitBreakerSnapshot> {
    this.pruneExpiredRuntimeAuthBreakers();
    const out: Record<string, RuntimeCircuitBreakerSnapshot> = {};
    for (const [key, state] of this.runtimeAuthFailures) {
      if (state.blockedUntil > Date.now()) out[key] = { ...state };
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private async safeAck(env: GatewayInboundEnvelope): Promise<void> {
    const accept = env.ack?.accept;
    if (!accept) return;
    try {
      await accept.call(env.ack);
    } catch (err) {
      this.log.warn("dispatcher: ack.accept failed", {
        messageId: env.message.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private getQueue(key: string): QueueState {
    let q = this.queues.get(key);
    if (!q) {
      q = {
        current: null,
        cancelGen: 0,
        serialBuffer: [],
        serialWorkerActive: false,
      };
      this.queues.set(key, q);
    }
    return q;
  }

  private deferMultimodal(queueKey: string, entry: DeferredMultimodalEntry): void {
    const list = this.deferredMultimodal.get(queueKey) ?? [];
    list.push(entry);
    while (list.length > MAX_BATCH_BUFFER_ENTRIES) {
      const dropped = list.shift()!;
      this.log.warn("dispatcher: deferred multimodal buffer overflow — dropped oldest", {
        queueKey,
        droppedMessageId: dropped.msg.id,
        bufferCap: MAX_BATCH_BUFFER_ENTRIES,
      });
      this.transcript.write({
        ts: nowIso(),
        kind: "dropped",
        turnId: dropped.turnId,
        agentId: dropped.msg.accountId,
        roomId: dropped.msg.conversation.id,
        topicId: dropped.msg.conversation.threadId ?? null,
        reason: "queue_overflow",
        supersededBy: null,
      });
    }
    this.deferredMultimodal.set(queueKey, list);
  }

  private takeDeferredMultimodal(queueKey: string): DeferredMultimodalEntry[] {
    const list = this.deferredMultimodal.get(queueKey);
    if (!list || list.length === 0) return [];
    this.deferredMultimodal.delete(queueKey);
    return list;
  }

  private runtimeAuthBreakerKey(route: GatewayRoute, msg: GatewayInboundMessage): string {
    const thread = msg.conversation.threadId ?? "";
    return `${route.runtime}:${msg.channel}:${msg.accountId}:${msg.conversation.id}:${thread}`;
  }

  private openRuntimeAuthBreaker(
    route: GatewayRoute,
    msg: GatewayInboundMessage,
  ): RuntimeAuthFailureState | null {
    const key = this.runtimeAuthBreakerKey(route, msg);
    const state = this.runtimeAuthFailures.get(key);
    if (!state) return null;
    if (state.blockedUntil > 0 && state.blockedUntil <= Date.now()) {
      this.runtimeAuthFailures.delete(key);
      return null;
    }
    return state.blockedUntil > Date.now() ? state : null;
  }

  private pruneExpiredRuntimeAuthBreakers(): void {
    const now = Date.now();
    for (const [key, state] of this.runtimeAuthFailures) {
      if (state.blockedUntil > 0 && state.blockedUntil <= now) this.runtimeAuthFailures.delete(key);
    }
  }

  private recordRuntimeAuthFailure(
    route: GatewayRoute,
    msg: GatewayInboundMessage,
    error: string,
  ): RuntimeAuthFailureState | null {
    const now = Date.now();
    const key = this.runtimeAuthBreakerKey(route, msg);
    const prev = this.runtimeAuthFailures.get(key);
    const failures = (prev?.failures ?? 0) + 1;
    const openedAt = prev?.openedAt ?? now;
    const state: RuntimeAuthFailureState = {
      key,
      runtime: route.runtime,
      channel: msg.channel,
      accountId: msg.accountId,
      conversationId: msg.conversation.id,
      threadId: msg.conversation.threadId ?? null,
      failures,
      openedAt,
      blockedUntil:
        failures >= this.runtimeAuthFailureThreshold
          ? now + this.runtimeAuthFailureCooldownMs
          : 0,
      lastFailureAt: now,
      lastError: error,
    };
    this.runtimeAuthFailures.set(key, state);
    if (state.blockedUntil > now) {
      this.log.error("dispatcher: runtime auth circuit breaker opened", {
        key,
        runtime: route.runtime,
        agentId: msg.accountId,
        roomId: msg.conversation.id,
        topicId: msg.conversation.threadId ?? null,
        failures,
        blockedUntil: state.blockedUntil,
        error,
      });
      this.notifyRuntimeCircuitBreakerChange();
      return state;
    }
    this.log.warn("dispatcher: runtime authentication failure recorded", {
      key,
      runtime: route.runtime,
      agentId: msg.accountId,
      roomId: msg.conversation.id,
      topicId: msg.conversation.threadId ?? null,
      failures,
      threshold: this.runtimeAuthFailureThreshold,
      error,
    });
    return null;
  }

  private clearRuntimeAuthFailures(route: GatewayRoute, msg: GatewayInboundMessage): void {
    const key = this.runtimeAuthBreakerKey(route, msg);
    if (!this.runtimeAuthFailures.delete(key)) return;
    this.log.info("dispatcher: runtime auth circuit breaker cleared", {
      key,
      runtime: route.runtime,
      agentId: msg.accountId,
      roomId: msg.conversation.id,
      topicId: msg.conversation.threadId ?? null,
    });
    this.notifyRuntimeCircuitBreakerChange();
  }

  private notifyRuntimeCircuitBreakerChange(): void {
    try {
      this.onRuntimeCircuitBreakerChange?.();
    } catch (err) {
      this.log.warn("dispatcher: onRuntimeCircuitBreakerChange threw", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async skipRuntimeForAuthBreaker(
    state: RuntimeAuthFailureState,
    route: GatewayRoute,
    msg: GatewayInboundMessage,
    channel: ChannelAdapter,
    turnId: string,
  ): Promise<void> {
    const error =
      `runtime authentication failed repeatedly; dispatch paused until ${new Date(state.blockedUntil).toISOString()}`;
    this.log.warn("dispatcher: runtime auth circuit breaker blocking turn", {
      key: state.key,
      runtime: route.runtime,
      agentId: msg.accountId,
      roomId: msg.conversation.id,
      topicId: msg.conversation.threadId ?? null,
      turnId,
      blockedUntil: state.blockedUntil,
    });
    this.transcript.write({
      ts: nowIso(),
      kind: "turn_error",
      turnId,
      agentId: msg.accountId,
      roomId: msg.conversation.id,
      topicId: msg.conversation.threadId ?? null,
      phase: "runtime",
      error,
      durationMs: 0,
    });

    const canDeliverRuntimeText = isOwnerChatRoom(msg) || !isBotCordChannel(channel);
    const canDeliverRuntimeDiagnostics = canDeliverRuntimeText || isBotCordChannel(channel);
    if (canDeliverRuntimeDiagnostics) {
      const sendResult = await this.sendReply(channel, {
        channel: msg.channel,
        accountId: msg.accountId,
        conversationId: msg.conversation.id,
        threadId: msg.conversation.threadId ?? null,
        type: "error",
        text: `⚠️ Runtime error: ${truncate(error, 500)}`,
        replyTo: this.providerReplyTo(msg),
        traceId: msg.trace?.id ?? null,
      }, turnId);
      this.emitOutbound({
        turnId,
        msg,
        runtime: route.runtime,
        runtimeSessionId: null,
        startedAt: Date.now(),
        finalText: truncateTextField(""),
        deliveryStatus: sendResult.ok ? "delivered" : "send_failed",
        deliveryReason: sendResult.ok ? null : sendResult.error,
        blocks: [],
      });
    }
  }

  private async runCancelPrevious(
    queueKey: string,
    route: GatewayRoute,
    text: string,
    msg: GatewayInboundEnvelope["message"],
    channel: ChannelAdapter,
    turnId: string,
    mergedFromTurnIds: string[] = [],
  ): Promise<void> {
    const q = this.getQueue(queueKey);
    // Bump the generation on every arrival. Older arrivals still awaiting
    // the prior turn's teardown will observe `myGen !== q.cancelGen` when
    // they resume and drop out, so only the newest message reaches runTurn.
    q.cancelGen += 1;
    const myGen = q.cancelGen;
    const prev = q.current;
    if (prev) {
      this.log.info("dispatcher: cancelling previous turn", {
        agentId: msg.accountId,
        roomId: msg.conversation.id,
        topicId: msg.conversation.threadId ?? null,
        turnId,
        prevTurnId: prev.turnId,
        queueKey,
      });
      // Record the supersede BEFORE aborting so the prev turn's finalize sees
      // the abort reason (TurnSupersededError) and skips writing turn_error.
      this.transcript.write({
        ts: nowIso(),
        kind: "dropped",
        turnId: prev.turnId,
        agentId: msg.accountId,
        roomId: msg.conversation.id,
        topicId: msg.conversation.threadId ?? null,
        reason: "queue_cancel_previous",
        supersededBy: turnId,
      });
      prev.controller.abort(new TurnSupersededError(turnId));
      // Wait for it to finish cleanup (it won't reply, won't persist).
      await prev.done.catch(() => undefined);
    }
    // After the await, a newer cancel-previous may have arrived and either
    // already fired its own abort + runTurn, or be mid-await itself. If so,
    // drop out silently — the newest turn is the only one that should run.
    if (myGen !== q.cancelGen) {
      this.log.info("dispatcher: cancel-previous superseded", {
        agentId: msg.accountId,
        roomId: msg.conversation.id,
        topicId: msg.conversation.threadId ?? null,
        turnId,
        queueKey,
      });
      // We didn't run the turn; emit dropped so the caller's inbound has a
      // matching path record. supersededBy is unknown at this layer (newer
      // arrival owns its own bump) — leave null.
      this.transcript.write({
        ts: nowIso(),
        kind: "dropped",
        turnId,
        agentId: msg.accountId,
        roomId: msg.conversation.id,
        topicId: msg.conversation.threadId ?? null,
        reason: "queue_cancel_previous",
        supersededBy: null,
      });
      return;
    }
    await this.runTurn(queueKey, route, text, msg, channel, turnId, mergedFromTurnIds);
  }

  /**
   * Serial mode with coalesce-on-drain semantics:
   *
   *   1. First arrival on an idle queue boots the worker, which dispatches a
   *      single-message turn immediately (no batching delay).
   *   2. Arrivals during an in-flight turn append to `serialBuffer`; when the
   *      worker finishes the current turn it drains the entire buffer and
   *      merges all pending entries into ONE next turn (folded into a single
   *      `raw.batch` so the composer renders them as multi-block input).
   *   3. Buffer caps: at most `MAX_BATCH_BUFFER_ENTRIES` entries are retained
   *      (drop oldest) and merged turns are further trimmed to fit
   *      `MAX_BATCH_BUFFER_CHARS` of total raw text.
   *
   * Note: the pre-composed `text` from `handle()` is intentionally discarded
   * here — at drain time the worker re-invokes `composeUserTurn` on the
   * merged message so the runtime sees a single coherent prompt covering all
   * coalesced messages.
   */
  private async runSerial(
    queueKey: string,
    route: GatewayRoute,
    _text: string,
    msg: GatewayInboundEnvelope["message"],
    channel: ChannelAdapter,
    turnId: string,
    mergedFromTurnIds: string[] = [],
  ): Promise<void> {
    const q = this.getQueue(queueKey);
    q.serialBuffer.push({ route, msg, channel, turnId });
    while (q.serialBuffer.length > MAX_BATCH_BUFFER_ENTRIES) {
      const dropped = q.serialBuffer.shift()!;
      this.log.warn("dispatcher: serial buffer overflow — dropped oldest entry", {
        queueKey,
        droppedMessageId: dropped.msg.id,
        bufferCap: MAX_BATCH_BUFFER_ENTRIES,
      });
      this.transcript.write({
        ts: nowIso(),
        kind: "dropped",
        turnId: dropped.turnId,
        agentId: dropped.msg.accountId,
        roomId: dropped.msg.conversation.id,
        topicId: dropped.msg.conversation.threadId ?? null,
        reason: "queue_overflow",
        supersededBy: null,
      });
    }
    if (q.serialWorkerActive) return;
    q.serialWorkerActive = true;
    try {
      while (q.serialBuffer.length > 0) {
        const drained = q.serialBuffer.splice(0, q.serialBuffer.length);
        const merged = this.mergeSerialBuffer(drained, queueKey);
        if (!merged) continue;
        // Drained entries other than the winner get a `batch_merged` dropped
        // record now (winner is always the last entry — see mergeSerialBuffer).
        if (drained.length > 1) {
          for (let i = 0; i < drained.length - 1; i++) {
            const lost = drained[i]!;
            this.transcript.write({
              ts: nowIso(),
              kind: "dropped",
              turnId: lost.turnId,
              agentId: lost.msg.accountId,
              roomId: lost.msg.conversation.id,
              topicId: lost.msg.conversation.threadId ?? null,
              reason: "batch_merged",
              supersededBy: merged.turnId,
            });
          }
        }
        const mergedTurnIds =
          drained.length > 1
            ? [...mergedFromTurnIds, ...drained.slice(0, -1).map((e) => e.turnId)]
            : mergedFromTurnIds;
        await this.runTurn(
          queueKey,
          merged.route,
          merged.text,
          merged.msg,
          merged.channel,
          merged.turnId,
          mergedTurnIds,
        );
      }
    } finally {
      q.serialWorkerActive = false;
    }
  }

  /**
   * Merge buffered serial entries into a single dispatchable unit. With one
   * entry the call is a near no-op (just recompose). With ≥2 entries this
   * flattens any per-entry `raw.batch` (the BotCord channel already groups
   * one inbox-poll's worth of same-room/topic messages into a `raw.batch`),
   * applies the `MAX_BATCH_BUFFER_CHARS` cap by dropping oldest individual
   * messages, and then synthesizes a merged inbound message anchored on the
   * latest entry's metadata (mentioned = OR across all entries).
   */
  private mergeSerialBuffer(
    entries: BufferedSerialEntry[],
    queueKey: string,
  ): {
    route: GatewayRoute;
    text: string;
    msg: GatewayInboundEnvelope["message"];
    channel: ChannelAdapter;
    turnId: string;
  } | null {
    if (entries.length === 0) return null;
    if (entries.length === 1) {
      const only = entries[0]!;
      return {
        route: only.route,
        text: this.recomposeUserTurn(only.msg),
        msg: only.msg,
        channel: only.channel,
        turnId: only.turnId,
      };
    }

    // Flatten: each entry's raw may already be a BatchedInboxRaw with
    // `.batch`; otherwise it's a single InboxMessage we treat as a 1-element
    // batch. Insertion order preserves chronology.
    const items: Array<Record<string, unknown>> = [];
    for (const e of entries) {
      const raw = e.msg.raw as Record<string, unknown> | null | undefined;
      const batch = raw && Array.isArray((raw as { batch?: unknown }).batch)
        ? ((raw as { batch: Array<Record<string, unknown>> }).batch)
        : null;
      if (batch) {
        for (const m of batch) items.push(m);
      } else if (raw) {
        items.push(raw);
      }
    }

    // Char-cap: drop oldest until we fit. Reserve at least one item so we
    // never produce an empty merged batch.
    let totalChars = items.reduce(
      (acc, m) => acc + (typeof m?.text === "string" ? (m.text as string).length : 0),
      0,
    );
    let droppedCount = 0;
    while (totalChars > MAX_BATCH_BUFFER_CHARS && items.length > 1) {
      const removed = items.shift()!;
      totalChars -= typeof removed?.text === "string" ? (removed.text as string).length : 0;
      droppedCount += 1;
    }
    if (droppedCount > 0) {
      this.log.warn("dispatcher: merged batch exceeded char cap — dropped oldest", {
        queueKey,
        droppedCount,
        remaining: items.length,
        totalChars,
        charCap: MAX_BATCH_BUFFER_CHARS,
      });
    }

    const latest = entries[entries.length - 1]!;
    const latestRaw = (latest.msg.raw as Record<string, unknown> | null | undefined) ?? {};
    const mergedRaw = { ...latestRaw, batch: items };
    const anyMentioned = entries.some((e) => e.msg.mentioned === true);
    const mergedText = entries
      .map((e) => (typeof e.msg.text === "string" ? e.msg.text.trim() : ""))
      .filter((s) => s.length > 0)
      .join("\n");
    const mergedMsg: GatewayInboundEnvelope["message"] = {
      ...latest.msg,
      ...(mergedText ? { text: mergedText } : {}),
      mentioned: anyMentioned,
      raw: mergedRaw,
    };
    return {
      route: latest.route,
      text: this.recomposeUserTurn(mergedMsg),
      msg: mergedMsg,
      channel: latest.channel,
      turnId: latest.turnId,
    };
  }

  /**
   * Re-run the user-turn composer at drain time. Mirrors the logic in
   * `handle()` but operates on the (possibly merged) message. Falls back to
   * raw trimmed text on composer failure so a buggy composer never drops a
   * turn.
   */
  private recomposeUserTurn(msg: GatewayInboundEnvelope["message"]): string {
    const rawText = typeof msg.text === "string" ? msg.text.trim() : "";
    if (!this.composeUserTurn) return rawText;
    try {
      const composed = this.composeUserTurn(msg);
      if (typeof composed === "string" && composed.length > 0) return composed;
    } catch (err) {
      this.log.warn("dispatcher: composeUserTurn (drain) threw — using raw text", {
        messageId: msg.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return rawText;
  }

  private async runTurn(
    queueKey: string,
    route: GatewayRoute,
    text: string,
    msg: GatewayInboundEnvelope["message"],
    channel: ChannelAdapter,
    turnId: string,
    mergedFromTurnIds: string[],
  ): Promise<void> {
    const q = this.getQueue(queueKey);
    const controller = new AbortController();
    const startedAt = Date.now();
    const snapshot: TurnStatusSnapshot = {
      key: queueKey,
      channel: msg.channel,
      accountId: msg.accountId,
      conversationId: msg.conversation.id,
      runtime: route.runtime,
      cwd: route.cwd,
      startedAt,
    };

    let resolveDone!: () => void;
    const done = new Promise<void>((res) => {
      resolveDone = res;
    });
    const slot: TurnSlot = {
      turnId,
      controller,
      timedOut: false,
      budgetExceeded: null,
      snapshot,
      done,
      dispatchedAt: startedAt,
      blocks: [],
    };
    q.current = slot;

    // Dispatched record — marks "this turn entered runtime".
    {
      const composedField = truncateTextField(text);
      const dispatched: import("./transcript.js").DispatchedTranscriptRecord = {
        ts: nowIso(),
        kind: "dispatched",
        turnId,
        agentId: msg.accountId,
        roomId: msg.conversation.id,
        topicId: msg.conversation.threadId ?? null,
        composedText: composedField.text,
        runtime: route.runtime,
      };
      if (mergedFromTurnIds.length > 0) dispatched.mergedFromTurnIds = mergedFromTurnIds;
      if (composedField.truncated) dispatched.truncated = { composedText: true };
      this.transcript.write(dispatched);
    }

    this.log.info("dispatcher: dispatched to runtime", {
      agentId: msg.accountId,
      roomId: msg.conversation.id,
      topicId: msg.conversation.threadId ?? null,
      turnId,
      runtime: route.runtime,
      cwd: route.cwd,
      ...(mergedFromTurnIds.length > 0 ? { mergedFromTurns: mergedFromTurnIds.length } : {}),
      composedPreview: logPreview(text),
    });

    const cloudRunBudget = extractCloudRunBudget(msg);
    const effectiveTurnTimeoutMs = Math.min(
      this.turnTimeoutMs,
      cloudRunBudget?.maxWallTimeMs ?? this.turnTimeoutMs,
    );
    let observedToolCalls = 0;

    // Hard-cap turn with a timeout.
    const timer = setTimeout(() => {
      slot.timedOut = true;
      this.log.warn("dispatcher: turn timed out", {
        agentId: msg.accountId,
        roomId: msg.conversation.id,
        topicId: msg.conversation.threadId ?? null,
        turnId,
        queueKey,
        timeoutMs: effectiveTurnTimeoutMs,
      });
      controller.abort();
    }, effectiveTurnTimeoutMs);
    if (typeof timer.unref === "function") timer.unref();

    const key = sessionKey({
      runtime: route.runtime,
      channel: msg.channel,
      accountId: msg.accountId,
      conversationKind: msg.conversation.kind,
      conversationId: msg.conversation.id,
      threadId: msg.conversation.threadId ?? null,
    });
    const entry = this.sessionStore.get(key);
    const sessionId = entry?.runtimeSessionId ?? null;
    let currentMemoryVersion: string | undefined;
    let runtimeText = text;
    const trustLevel = route.trustLevel ?? "trusted";

    const streamable = msg.trace?.streamable === true;
    const traceId = msg.trace?.id;
    const canType =
      typeof traceId === "string" &&
      typeof channel.typing === "function" &&
      (streamable || !isBotCordChannel(channel));
    const canStream =
      streamable && typeof traceId === "string" && typeof channel.streamBlock === "function";
    const recordBlock = (block: StreamBlock): void => {
      if (block.kind === "tool_use" && cloudRunBudget?.maxToolCalls !== undefined) {
        observedToolCalls += 1;
        if (observedToolCalls > cloudRunBudget.maxToolCalls && !controller.signal.aborted) {
          slot.budgetExceeded = `tool call budget exceeded after ${observedToolCalls} tool call(s)`;
          this.log.warn("dispatcher: cloud_run tool budget exceeded", {
            agentId: msg.accountId,
            roomId: msg.conversation.id,
            topicId: msg.conversation.threadId ?? null,
            turnId,
            queueKey,
            maxToolCalls: cloudRunBudget.maxToolCalls,
            observedToolCalls,
          });
          controller.abort(new Error(slot.budgetExceeded));
        }
      }
      const summary = summarizeStreamBlock(block);
      slot.blocks.push(summary);
      if (this.transcript.enabled) {
        this.transcript.write({
          ts: new Date().toISOString(),
          kind: "block",
          turnId,
          agentId: msg.accountId,
          roomId: msg.conversation.id,
          topicId: msg.conversation.threadId ?? null,
          runtime: route.runtime,
          seq: block.seq,
          blockType: block.kind,
          summary,
          ...(transcriptBlocksVerbose() ? { raw: redactAndCap(block.raw) } : {}),
        });
      }
    };

    // Owner-chat lifecycle state for typing/thinking. The dispatcher is the
    // only component that sees turn boundaries + channel capabilities + trace
    // ids together, so it owns the收束: once `typing.started` fires we never
    // re-fire it within this turn (frontend clears via stream/message
    // arrival), and `thinking` is auto-synthesized on the first non-assistant
    // block so adapters that emit nothing-but-blocks still drive the
    // "Thinking..." UI.
    let typingLoopStarted = false;
    let typingRefreshTimer: NodeJS.Timeout | null = null;
    let thinkingActive = false;
    /**
     * Sticky: once we've forwarded any assistant_text to the wire, we stop
     * auto-synthesizing thinking on plain `system`/`other` blocks. This
     * prevents the post-prose flicker caused by Codex's `turn.completed` /
     * Claude Code's `result` (both arrive as system/other AFTER the prose).
     * `tool_use` is the explicit exception — agents that legitimately go
     * back to work after a partial answer should still drive "Thinking…".
     */
    let sawAssistantText = false;
    let blocksSent = 0;

    const forwardBlockToChannel = canStream
      ? (block: StreamBlock) => {
          // Re-sequence at the wire boundary so synthesized thinking blocks
          // interleave cleanly with adapter-emitted blocks; adapters keep
          // their own per-turn seq for tracing/logging only.
          blocksSent += 1;
          const ctx = {
            traceId: traceId!,
            accountId: msg.accountId,
            conversationId: msg.conversation.id,
            block: { ...block, seq: blocksSent },
            log: this.log,
          };
          // Coerce a synchronous throw from a non-async adapter into the same
          // warn path as an async rejection so a buggy channel never tears
          // down the turn (the adapter contract is fire-and-forget).
          try {
            const ret = channel.streamBlock!(ctx);
            if (ret && typeof (ret as Promise<void>).catch === "function") {
              (ret as Promise<void>).catch((err) => {
                this.log.warn("dispatcher: streamBlock failed", {
                  traceId,
                  error: err instanceof Error ? err.message : String(err),
                });
              });
            }
          } catch (err) {
            this.log.warn("dispatcher: streamBlock threw", {
              traceId,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      : undefined;

    const sendThinkingMarker = (
      phase: "started" | "updated" | "stopped",
      label: string | undefined,
      source: "dispatcher" | "runtime",
    ): void => {
      if (!forwardBlockToChannel) return;
      const raw: Record<string, unknown> = { phase, source };
      if (label) raw.label = label;
      const synth: StreamBlock = { raw, kind: "thinking", seq: 0 };
      // Intentionally NOT `recordBlock(synth)` — the transcript stays
      // adapter-truth so downstream log consumers see only what the runtime
      // actually emitted, not daemon-synthesized lifecycle frames.
      forwardBlockToChannel(synth);
    };

    const sendTypingPing = (): void => {
      if (!canType) return;
      const key = `${msg.accountId}:${msg.conversation.id}`;
      const now = Date.now();
      const last = this.recentTypingPings.get(key);
      if (last !== undefined && now - last < TYPING_DEBOUNCE_MS) {
        // Within the debounce window — Hub's 2s dedup absorbs this. The
        // window thins out cancel-previous bursts; it does NOT fully
        // prevent 429s when many active rooms ping concurrently, so the
        // try/catch around `channel.typing()` is what actually keeps the
        // turn alive on rate-limit (backend hub.py:1675).
        return;
      }
      // True LRU: delete-then-set bumps the entry to the tail of the Map
      // insertion order, so chronically active conversations never get
      // evicted by an unrelated newcomer at the cap.
      this.recentTypingPings.delete(key);
      this.recentTypingPings.set(key, now);
      if (this.recentTypingPings.size > TYPING_RECENCY_CAP) {
        const oldest = this.recentTypingPings.keys().next().value;
        if (oldest !== undefined) this.recentTypingPings.delete(oldest);
      }
      const ctx = {
        traceId: traceId!,
        accountId: msg.accountId,
        conversationId: msg.conversation.id,
        log: this.log,
      };
      try {
        const ret = channel.typing!(ctx);
        if (ret && typeof (ret as Promise<void>).catch === "function") {
          (ret as Promise<void>).catch((err) => {
            this.log.warn("dispatcher: channel.typing failed", {
              traceId,
              error: err instanceof Error ? err.message : String(err),
            });
          });
        }
      } catch (err) {
        this.log.warn("dispatcher: channel.typing threw", {
          traceId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    };

    const fireTypingIfNeeded = (): void => {
      if (!canType || typingLoopStarted) return;
      typingLoopStarted = true;
      sendTypingPing();
      typingRefreshTimer = setInterval(sendTypingPing, TYPING_REFRESH_MS);
      if (typeof typingRefreshTimer.unref === "function") typingRefreshTimer.unref();
    };

    const stopTypingRefresh = (): void => {
      if (!typingRefreshTimer) return;
      clearInterval(typingRefreshTimer);
      typingRefreshTimer = null;
    };

    const onStatus = canType || canStream
      ? (event: RuntimeStatusEvent) => {
          // Drop runtime callbacks after this turn's controller aborts —
          // NDJSON/ACP adapters keep parsing stdout until the child exits
          // (up to KILL_GRACE_MS after SIGTERM), so without this guard a
          // superseded turn leaks frames to the new turn's UI.
          if (controller.signal.aborted) return;
          if (event.kind === "typing") {
            // `/hub/typing` has no stopped semantic — frontend self-clears on
            // stream/message arrival. typing.stopped is observed for daemon
            // bookkeeping only (currently a no-op; kept for telemetry).
            if (event.phase === "started") fireTypingIfNeeded();
            return;
          }
          if (event.phase === "stopped") {
            // Forward to wire ONLY if we previously announced thinking — that
            // way `finalizeThinkingIfActive` doesn't double-emit, and adapters
            // that signal terminal closure earlier than child exit (e.g.
            // acp-stream's prompt-done) reach the frontend without waiting.
            if (thinkingActive) {
              sendThinkingMarker("stopped", event.label, "runtime");
            }
            thinkingActive = false;
            return;
          }
          // Runtime-emitted thinking.started/.updated is trusted unconditionally:
          // we deliberately do NOT apply the `sawAssistantText` sticky guard
          // here, only to dispatcher-synthesized starts. Adapters opting into
          // explicit status events accept the responsibility of driving a
          // sensible lifecycle (don't fire .started after the final answer).
          thinkingActive = true;
          sendThinkingMarker(event.phase, event.label, "runtime");
        }
      : undefined;

    const shouldObserveBlocks =
      canStream || this.transcript.enabled || cloudRunBudget?.maxToolCalls !== undefined;
    const onBlock = shouldObserveBlocks
      ? (block: StreamBlock) => {
          // Always record adapter-emitted blocks for transcript fidelity, even
          // after abort — the transcript reflects what the runtime emitted,
          // not what the dispatcher chose to forward.
          recordBlock(block);
          if (controller.signal.aborted) return;
          if (!canStream) return;
          // Synthesize thinking.started before non-assistant blocks. After
          // we've seen any assistant_text, only `tool_use` may re-enter
          // thinking — terminal markers like `system`/`other` (codex
          // `turn.completed`, claude `result`) would otherwise flicker
          // "Thinking…" right after the final answer.
          if (!thinkingActive && block.kind !== "assistant_text") {
            const allowed = !sawAssistantText || block.kind === "tool_use";
            if (allowed) {
              thinkingActive = true;
              sendThinkingMarker("started", undefined, "dispatcher");
            }
          }
          // Once assistant prose lands, the user is reading the answer — exit
          // thinking. Frontend hides "Thinking..." once any assistant_text
          // block has flushed; we just keep our internal flag aligned.
          if (block.kind === "assistant_text") {
            thinkingActive = false;
            sawAssistantText = true;
          }
          forwardBlockToChannel?.(block);
        }
      : undefined;

    // Helper used by terminal paths (success / timeout / error) to ensure
    // the frontend doesn't get stuck in "Thinking..." when no assistant_text
    // ever lands. Skips on cancel-previous because the superseder will run
    // its own typing/thinking sequence.
    const finalizeThinkingIfActive = (): void => {
      if (!canStream || !thinkingActive) return;
      const supersededByCancel = controller.signal.aborted && !slot.timedOut;
      if (supersededByCancel) return;
      thinkingActive = false;
      sendThinkingMarker("stopped", undefined, "dispatcher");
    };

    // Eagerly fire typing.started before runtime.run so the user sees
    // "agent is responding" within ~one round-trip even if the runtime takes
    // seconds before its first block.
    fireTypingIfNeeded();

    // Compute systemContext right before dispatch. The builder must NOT block
    // the turn on failure — log and continue so a flaky memory read can't
    // silence the agent.
    let systemContext: string | undefined;
    if (this.buildSystemContext) {
      try {
        const result = await this.buildSystemContext(msg);
        if (typeof result === "string" && result.length > 0) {
          systemContext = result;
        }
      } catch (err) {
        this.log.warn("buildSystemContext threw — continuing without systemContext", {
          error: err instanceof Error ? err.message : String(err),
          messageId: msg.id,
        });
      }
    }

    if (this.buildMemoryContext) {
      try {
        const snapshot = await this.buildMemoryContext(msg);
        if (
          snapshot &&
          typeof snapshot.version === "string" &&
          snapshot.version.length > 0
        ) {
          currentMemoryVersion = snapshot.version;
          const previousMemoryVersion = entry?.memoryVersion ?? null;
          if (sessionId && previousMemoryVersion !== currentMemoryVersion) {
            runtimeText = buildMemoryUpdateNotice({
              previousVersion: previousMemoryVersion,
              currentVersion: currentMemoryVersion,
              userTurn: text,
            });
            this.log.info("dispatcher: injected memory update notice", {
              agentId: msg.accountId,
              roomId: msg.conversation.id,
              topicId: msg.conversation.threadId ?? null,
              turnId,
              previousMemoryVersion,
              currentMemoryVersion,
            });
          }
        }
      } catch (err) {
        this.log.warn("buildMemoryContext threw — continuing without memory version check", {
          error: err instanceof Error ? err.message : String(err),
          messageId: msg.id,
        });
      }
    }

    const runtime = this.runtimeFactory(route.runtime, route.extraArgs);
    let result: RuntimeRunResult | undefined;
    let threw: unknown;
    let activeSessionId: string | null = sessionId;
    const turnStartedAt = Date.now();
    try {
      try {
        const runRuntime = (textForRun: string, sessionIdForRun: string | null) =>
          runtime.run({
            text: textForRun,
            sessionId: sessionIdForRun,
            cwd: route.cwd,
            accountId: msg.accountId,
            hubUrl: this.resolveHubUrl?.(msg.accountId),
            extraArgs: route.extraArgs,
            signal: controller.signal,
            trustLevel,
            systemContext,
            onBlock,
            onStatus,
            context: {
              turnId,
              messageId: msg.id,
              roomId: msg.conversation.id,
              topicId: msg.conversation.threadId ?? null,
              channel: msg.channel,
              conversationKind: msg.conversation.kind,
            },
            ...(cloudRunBudget ? { budget: cloudRunBudget } : {}),
            gateway: route.gateway,
            ...(route.hermesProfile ? { hermesProfile: route.hermesProfile } : {}),
          });

        result = await runRuntime(runtimeText, sessionId);
        const firstError = result.error ?? "";
        const firstReply = (result.text || "").trim();
        const shouldRetryFresh =
          route.runtime === "codex" &&
          !!sessionId &&
          !!firstError &&
          !firstReply &&
          !looksLikeRuntimeAuthFailure(firstError) &&
          looksLikeRecoverableSessionFailure(firstError) &&
          !controller.signal.aborted &&
          !slot.timedOut &&
          !slot.budgetExceeded;

        if (shouldRetryFresh) {
          try {
            await this.sessionStore.delete(key);
            this.log.info("dispatcher: dropped unrecoverable runtime session before fresh retry", {
              key,
              prevRuntimeSessionId: sessionId,
              runtime: route.runtime,
              error: firstError,
            });
          } catch (err) {
            this.log.warn("dispatcher: session-store.delete failed before fresh retry", {
              key,
              error: err instanceof Error ? err.message : String(err),
            });
          }

          let recoveryContext: string | null | undefined;
          if (this.buildRuntimeRecoveryContext) {
            try {
              recoveryContext = await this.buildRuntimeRecoveryContext(msg);
            } catch (err) {
              this.log.warn("dispatcher: buildRuntimeRecoveryContext threw — retrying without recent room context", {
                agentId: msg.accountId,
                roomId: msg.conversation.id,
                topicId: msg.conversation.threadId ?? null,
                turnId,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }

          activeSessionId = null;
          runtimeText = buildRuntimeRecoveryPrompt({
            userTurn: text,
            error: firstError,
            recoveryContext,
          });
          this.log.info("dispatcher: retrying codex turn in a fresh session with recovery context", {
            agentId: msg.accountId,
            roomId: msg.conversation.id,
            topicId: msg.conversation.threadId ?? null,
            turnId,
            queueKey,
          });
          result = await runRuntime(runtimeText, null);
        }
      } catch (err) {
        threw = err;
      } finally {
        clearTimeout(timer);
      }

      // Fire onTurnComplete observer. Cloud daemon hooks this to settle
      // ``cloud_run`` envelopes against the Hub usage ledger. Errors are
      // swallowed so settle failures never break the reply path.
      if (this.onTurnComplete) {
        const wallTimeMs = Date.now() - turnStartedAt;
        try {
          await this.onTurnComplete({
            message: msg,
            result,
            wallTimeMs,
            ...(threw !== undefined ? { error: threw } : {}),
          });
        } catch (hookErr) {
          this.log.warn("dispatcher: onTurnComplete threw — continuing", {
            error: hookErr instanceof Error ? hookErr.message : String(hookErr),
            messageId: msg.id,
          });
        }
      }

      // Re-check the abort signal AFTER runtime.run resolves but BEFORE any
      // side effects (session write, reply send). This closes the race where
      // a cancel-previous arrives between runtime.run resolving and the
      // post-runtime block running: keeping `q.current` pointing at this slot
      // until after the reply lets the new arrival trip our abort signal, and
      // this check then drops us silently. Timed-out turns still fall through
      // to send their error reply.
      //
      // Note on transcript: the supersede path already wrote the `dropped`
      // record from `runCancelPrevious` BEFORE aborting, so we MUST NOT also
      // emit a `turn_error` here — that would violate the "exactly one
      // terminal record per turnId" invariant.
      if (controller.signal.aborted && !slot.timedOut && !slot.budgetExceeded) {
        return;
      }

      // Reply gating: BotCord network rooms only accept the runtime's plain
      // text output in owner-chat. Other BotCord rooms expect the agent to
      // call the `botcord_send` tool (or `botcord send` CLI via Bash)
      // explicitly, so final assistant text is logged and dropped there.
      // Third-party gateways (Telegram / WeChat) are themselves direct
      // message transports; their final runtime text is the reply.
      //
      // Owner-chat is identified by either the `rm_oc_` room prefix OR
      // `source_type === "dashboard_user_chat"` on the raw envelope — the
      // same dual check used by `sender-classify.ts:classifyActivitySender`,
      // so the dispatcher's reply gating stays in lock-step with the
      // composer's owner-bypass.
      //
      // Side effect: `onOutbound` (loop-risk tracking) only fires when a
      // reply actually leaves the dispatcher. In non-owner-chat rooms the
      // expectation is that the agent's `botcord_send` tool calls do their
      // own loop-risk accounting downstream.
      const isOwnerChat = isOwnerChatRoom(msg);
      const canDeliverRuntimeText = isOwnerChat || !isBotCordChannel(channel);
      const canDeliverRuntimeDiagnostics = canDeliverRuntimeText || isBotCordChannel(channel);

      if (slot.timedOut || slot.budgetExceeded) {
        const phase = slot.budgetExceeded ? "budget" : "timeout";
        const error = slot.budgetExceeded ?? `runtime timeout after ${effectiveTurnTimeoutMs}ms`;
        this.transcript.write({
          ts: nowIso(),
          kind: "turn_error",
          turnId,
          agentId: msg.accountId,
          roomId: msg.conversation.id,
          topicId: msg.conversation.threadId ?? null,
          phase,
          error,
          durationMs: Date.now() - slot.dispatchedAt,
        });
        if (canDeliverRuntimeDiagnostics) {
          await this.sendReply(channel, {
            channel: msg.channel,
            accountId: msg.accountId,
            conversationId: msg.conversation.id,
            threadId: msg.conversation.threadId ?? null,
            type: "error",
            text: slot.budgetExceeded
              ? `Cloud run budget exceeded: ${slot.budgetExceeded}`
              : `Runtime timeout after ${Math.round(effectiveTurnTimeoutMs / 60000)} minute(s); aborted`,
            replyTo: this.providerReplyTo(msg),
            traceId: msg.trace?.id ?? null,
          }, turnId);
        } else {
          this.log.warn("dispatcher: timeout in non-owner-chat room — error reply suppressed", {
            agentId: msg.accountId,
            roomId: msg.conversation.id,
            topicId: msg.conversation.threadId ?? null,
            turnId,
            queueKey,
            timeoutMs: effectiveTurnTimeoutMs,
            budgetExceeded: slot.budgetExceeded,
          });
        }
        return;
      }

      if (threw) {
        const errMsg = threw instanceof Error ? threw.message : String(threw);
        this.log.error("dispatcher: runtime threw", {
          agentId: msg.accountId,
          roomId: msg.conversation.id,
          topicId: msg.conversation.threadId ?? null,
          turnId,
          queueKey,
          runtime: route.runtime,
          error: errMsg,
        });
        this.transcript.write({
          ts: nowIso(),
          kind: "turn_error",
          turnId,
          agentId: msg.accountId,
          roomId: msg.conversation.id,
          topicId: msg.conversation.threadId ?? null,
          phase: "runtime",
          error: errMsg,
          durationMs: Date.now() - slot.dispatchedAt,
        });
        if (canDeliverRuntimeDiagnostics) {
          await this.sendReply(channel, {
            channel: msg.channel,
            accountId: msg.accountId,
            conversationId: msg.conversation.id,
            threadId: msg.conversation.threadId ?? null,
            type: "error",
            text: `⚠️ Runtime error: ${truncate(errMsg, 500)}`,
            replyTo: this.providerReplyTo(msg),
            traceId: msg.trace?.id ?? null,
          }, turnId);
        } else {
          this.log.warn("dispatcher: runtime error in non-owner-chat room — error reply suppressed", {
            agentId: msg.accountId,
            roomId: msg.conversation.id,
            topicId: msg.conversation.threadId ?? null,
            turnId,
            queueKey,
          });
        }
        return;
      }

      if (!result) return;

      const rawReplyText = (result.text || "").trim();
      const replyLooksLikeAuthFailure = looksLikeRuntimeAuthFailure(rawReplyText);
      const replyText = replyLooksLikeAuthFailure ? "" : rawReplyText;
      const effectiveError = result.error ?? (replyLooksLikeAuthFailure ? rawReplyText : undefined);
      const authFailureError =
        effectiveError && looksLikeRuntimeAuthFailure(effectiveError) ? effectiveError : undefined;
      const finalTextField = truncateTextField(replyLooksLikeAuthFailure ? "" : result.text || "");
      if (replyLooksLikeAuthFailure) {
        this.log.error("dispatcher: runtime text looked like authentication failure; treating as error", {
          agentId: msg.accountId,
          roomId: msg.conversation.id,
          topicId: msg.conversation.threadId ?? null,
          turnId,
          runtime: route.runtime,
          error: rawReplyText,
        });
      }
      if (authFailureError) {
        this.recordRuntimeAuthFailure(route, msg, authFailureError);
      } else if (!effectiveError) {
        this.clearRuntimeAuthFailures(route, msg);
      }

      // Persist session before reply so next turn sees the new id even if send fails.
      //
      // Adapter contract:
      //   had-inbound-sessionId + result.error + no reply text
      //                               → the prior session is suspect/dead; delete it so
      //                                 we don't keep resuming a stale id every turn
      //                                 even when the adapter echoes that id back
      //   result.newSessionId truthy  → upsert the entry
      //   otherwise                   → no-op (e.g. codex intentionally never persists)
      if (activeSessionId && effectiveError && !replyText) {
        try {
          await this.sessionStore.delete(key);
          this.log.info("dispatcher: dropped stale runtime session", {
            key,
            prevRuntimeSessionId: activeSessionId,
            nextRuntimeSessionId: result.newSessionId || null,
            error: effectiveError,
          });
        } catch (err) {
          this.log.warn("dispatcher: session-store.delete failed", {
            key,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      } else if (result.newSessionId && !authFailureError) {
        const session: GatewaySessionEntry = {
          key,
          runtime: route.runtime,
          runtimeSessionId: result.newSessionId,
          memoryVersion: currentMemoryVersion ?? entry?.memoryVersion ?? null,
          channel: msg.channel,
          accountId: msg.accountId,
          conversationKind: msg.conversation.kind,
          conversationId: msg.conversation.id,
          threadId: msg.conversation.threadId ?? null,
          cwd: route.cwd,
          updatedAt: Date.now(),
        };
        try {
          const prevRuntimeSessionId = activeSessionId;
          await this.sessionStore.set(session);
          this.log.debug("dispatcher: persisted runtime session", {
            key,
            prevRuntimeSessionId,
            nextRuntimeSessionId: result.newSessionId,
          });
        } catch (err) {
          this.log.warn("dispatcher: session-store.set failed", {
            key,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      } else if (activeSessionId && effectiveError) {
        try {
          await this.sessionStore.delete(key);
          this.log.info("dispatcher: dropped stale runtime session", {
            key,
            prevRuntimeSessionId: activeSessionId,
            error: effectiveError,
          });
        } catch (err) {
          this.log.warn("dispatcher: session-store.delete failed", {
            key,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      if (!replyText) {
        if (effectiveError) {
          this.log.warn("dispatcher: runtime returned error without reply text", {
            agentId: msg.accountId,
            roomId: msg.conversation.id,
            topicId: msg.conversation.threadId ?? null,
            turnId,
            runtime: route.runtime,
            error: effectiveError,
          });
          if (canDeliverRuntimeDiagnostics) {
            const sendResult = await this.sendReply(channel, {
              channel: msg.channel,
              accountId: msg.accountId,
              conversationId: msg.conversation.id,
              threadId: msg.conversation.threadId ?? null,
              type: "error",
              text: `⚠️ Runtime error: ${truncate(effectiveError, 500)}`,
              replyTo: this.providerReplyTo(msg),
              traceId: msg.trace?.id ?? null,
            }, turnId);
            this.emitOutbound({
              turnId,
              msg,
              runtime: route.runtime,
              runtimeSessionId: result.newSessionId || null,
              startedAt: slot.dispatchedAt,
              costUsd: result.costUsd,
              finalText: finalTextField,
              deliveryStatus: sendResult.ok ? "delivered" : "send_failed",
              deliveryReason: sendResult.ok ? null : sendResult.error,
              blocks: slot.blocks,
            });
            return;
          }
        }
        this.emitOutbound({
          turnId,
          msg,
          runtime: route.runtime,
          runtimeSessionId: result.newSessionId || null,
          startedAt: slot.dispatchedAt,
          costUsd: result.costUsd,
          finalText: finalTextField,
          deliveryStatus: "empty_text",
          deliveryReason: effectiveError ?? null,
          blocks: slot.blocks,
        });
        return;
      }

      if (!canDeliverRuntimeText) {
        // Non-owner BotCord rooms: result.text never goes out. The agent is
        // expected to have used the `botcord_send` tool / `botcord send` CLI
        // already; whatever it left in the runtime's final assistant text is
        // discarded so it doesn't leak into the room.
        this.log.debug(
          "dispatcher: non-owner-chat — discarding result.text (agent must use botcord_send)",
          {
            agentId: msg.accountId,
            roomId: msg.conversation.id,
            topicId: msg.conversation.threadId ?? null,
            turnId,
            queueKey,
            replyTextLen: replyText.length,
          },
        );
        this.emitOutbound({
          turnId,
          msg,
          runtime: route.runtime,
          runtimeSessionId: result.newSessionId || null,
          startedAt: slot.dispatchedAt,
          costUsd: result.costUsd,
          finalText: finalTextField,
          deliveryStatus: "gated_non_owner_chat",
          deliveryReason: null,
          blocks: slot.blocks,
        });
        return;
      }

      // One last abort check immediately before the send. Narrows the window
      // in which a cancel-previous arriving during session-store.set could
      // still slip a stale reply past us.
      if (controller.signal.aborted && !slot.timedOut) {
        return;
      }

      const attachments =
        (isOwnerChat && isBotCordChannel(channel)
          ? collectOwnerChatReplyAttachments(replyText, route.cwd)
          : undefined) ?? [];
      if (attachments.length > 0) {
        this.log.info("dispatcher: attaching owner-chat reply artifacts", {
          agentId: msg.accountId,
          roomId: msg.conversation.id,
          topicId: msg.conversation.threadId ?? null,
          turnId,
          count: attachments.length,
        });
      }

      const sendResult = await this.sendReply(channel, {
        channel: msg.channel,
        accountId: msg.accountId,
        conversationId: msg.conversation.id,
        threadId: msg.conversation.threadId ?? null,
        text: replyText,
        attachments: attachments.length > 0 ? attachments : undefined,
        replyTo: this.providerReplyTo(msg),
        traceId: msg.trace?.id ?? null,
      }, turnId);
      this.emitOutbound({
        turnId,
        msg,
        runtime: route.runtime,
        runtimeSessionId: result.newSessionId || null,
        startedAt: slot.dispatchedAt,
        costUsd: result.costUsd,
        finalText: finalTextField,
        deliveryStatus: sendResult.ok ? "delivered" : "send_failed",
        deliveryReason: sendResult.ok ? null : sendResult.error,
        blocks: slot.blocks,
      });
    } finally {
      stopTypingRefresh();
      // Emit a final thinking.stopped on terminal paths so the frontend
      // never sticks at "Thinking..." when no assistant_text ever landed
      // (timeout, error, gated reply). Skipped on cancel-previous: the
      // superseder is about to run its own typing/thinking lifecycle.
      finalizeThinkingIfActive();
      // Clear slot ownership AFTER the reply has been sent (or skipped).
      // Only then do cancel-previous arrivals stop finding this slot — which
      // is exactly what we want: while we're in the post-runtime window, a
      // newer arrival should find `q.current === slot`, call `abort()`, and
      // let our abort-checks above drop this turn silently.
      if (q.current === slot) q.current = null;
      resolveDone();
    }
  }

  private async sendReply(
    channel: ChannelAdapter,
    outbound: GatewayOutboundMessage,
    turnId?: string,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
      await channel.send({ message: outbound, log: this.log });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.log.warn("dispatcher: channel.send failed", {
        agentId: outbound.accountId,
        roomId: outbound.conversationId,
        topicId: outbound.threadId ?? null,
        ...(turnId ? { turnId } : {}),
        channel: outbound.channel,
        error,
      });
      return { ok: false, error };
    }
    if (this.onOutbound) {
      try {
        await this.onOutbound(outbound);
      } catch (err) {
        this.log.warn("dispatcher: onOutbound threw — continuing", {
          agentId: outbound.accountId,
          roomId: outbound.conversationId,
          topicId: outbound.threadId ?? null,
          ...(turnId ? { turnId } : {}),
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return { ok: true };
  }

  private providerReplyTo(msg: GatewayInboundMessage): string {
    return pickReplyToTarget(msg);
  }

  private emitInbound(turnId: string, msg: GatewayInboundEnvelope["message"]): void {
    if (!this.transcript.enabled) return;
    const rawText = typeof msg.text === "string" ? msg.text : "";
    const tField = truncateTextField(rawText);
    const raw = msg.raw as Record<string, unknown> | null | undefined;
    const batch =
      raw && typeof raw === "object" && Array.isArray((raw as { batch?: unknown }).batch)
        ? (raw as { batch: unknown[] }).batch.length
        : undefined;
    const rec: import("./transcript.js").InboundTranscriptRecord = {
      ts: nowIso(),
      kind: "inbound",
      turnId,
      agentId: msg.accountId,
      roomId: msg.conversation.id,
      topicId: msg.conversation.threadId ?? null,
      messageId: msg.id,
      sender: { id: msg.sender.id, kind: msg.sender.kind, ...(msg.sender.name ? { name: msg.sender.name } : {}) },
      text: tField.text,
    };
    if (batch !== undefined && batch > 1) rec.rawBatchEntries = batch;
    if (msg.trace?.id) {
      rec.trace = { id: msg.trace.id, ...(msg.trace.streamable ? { streamable: true } : {}) };
    }
    if (tField.truncated) rec.truncated = { text: true };
    this.transcript.write(rec);
  }

  private emitOutbound(args: {
    turnId: string;
    msg: GatewayInboundEnvelope["message"];
    runtime: string;
    runtimeSessionId: string | null;
    startedAt: number;
    costUsd?: number;
    finalText: { text: string; truncated: boolean };
    deliveryStatus: DeliveryStatus;
    deliveryReason: string | null;
    blocks: TranscriptBlockSummary[];
  }): void {
    const durationMs = Date.now() - args.startedAt;
    this.log.info("dispatcher: outbound emitted", {
      agentId: args.msg.accountId,
      roomId: args.msg.conversation.id,
      topicId: args.msg.conversation.threadId ?? null,
      turnId: args.turnId,
      runtime: args.runtime,
      deliveryStatus: args.deliveryStatus,
      ...(args.deliveryReason ? { deliveryReason: args.deliveryReason } : {}),
      durationMs,
      replyPreview: logPreview(args.finalText.text),
      ...(typeof args.costUsd === "number" ? { costUsd: args.costUsd } : {}),
    });
    if (!this.transcript.enabled) return;
    const rec: import("./transcript.js").OutboundTranscriptRecord = {
      ts: nowIso(),
      kind: "outbound",
      turnId: args.turnId,
      agentId: args.msg.accountId,
      roomId: args.msg.conversation.id,
      topicId: args.msg.conversation.threadId ?? null,
      runtime: args.runtime,
      runtimeSessionId: args.runtimeSessionId,
      durationMs,
      finalText: args.finalText.text,
      deliveryStatus: args.deliveryStatus,
      deliveryReason: args.deliveryReason,
    };
    if (typeof args.costUsd === "number") rec.costUsd = args.costUsd;
    if (args.blocks.length > 0) rec.blocks = args.blocks;
    if (args.finalText.truncated) rec.truncated = { finalText: true };
    this.transcript.write(rec);
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function collectOwnerChatReplyAttachments(text: string, cwd: string): GatewayOutboundMessage["attachments"] {
  const baseDir = safeRealpath(cwd);
  if (!baseDir) return undefined;

  const out: NonNullable<GatewayOutboundMessage["attachments"]> = [];
  const seen = new Set<string>();
  REPLY_LOCAL_PATH_RE.lastIndex = 0;

  for (const match of text.matchAll(REPLY_LOCAL_PATH_RE)) {
    const rawPath = match[2];
    if (!rawPath || looksLikeUrl(rawPath)) continue;

    const resolved = path.isAbsolute(rawPath)
      ? path.resolve(rawPath)
      : path.resolve(baseDir, rawPath);
    const realPath = safeRealpath(resolved);
    if (!realPath || seen.has(realPath) || !isPathInside(baseDir, realPath)) continue;

    const ext = path.extname(realPath).toLowerCase();
    if (!AUTO_ATTACHMENT_EXTENSIONS.has(ext)) continue;

    let size = 0;
    try {
      const stat = statSync(realPath);
      if (!stat.isFile()) continue;
      size = stat.size;
    } catch {
      continue;
    }
    if (size <= 0 || size > AUTO_ATTACHMENT_MAX_BYTES) continue;

    const contentType = contentTypeForExtension(ext);
    out.push({
      filePath: realPath,
      filename: path.basename(realPath),
      sourcePath: rawPath,
      ...(contentType ? { contentType } : {}),
      ...(contentType?.startsWith("image/") ? { kind: "image" as const } : { kind: "file" as const }),
    });
    seen.add(realPath);
    if (out.length >= AUTO_ATTACHMENT_LIMIT) break;
  }

  return out.length > 0 ? out : undefined;
}

function safeRealpath(input: string): string | null {
  try {
    return realpathSync(input);
  } catch {
    return null;
  }
}

function isPathInside(baseDir: string, candidate: string): boolean {
  const rel = path.relative(baseDir, candidate);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function looksLikeUrl(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith("//");
}

function contentTypeForExtension(ext: string): string | undefined {
  switch (ext) {
    case ".avif":
      return "image/avif";
    case ".bmp":
      return "image/bmp";
    case ".csv":
      return "text/csv";
    case ".gif":
      return "image/gif";
    case ".htm":
    case ".html":
      return "text/html";
    case ".jpeg":
    case ".jpg":
      return "image/jpeg";
    case ".pdf":
      return "application/pdf";
    case ".png":
      return "image/png";
    case ".svg":
      return "image/svg+xml";
    case ".webp":
      return "image/webp";
    case ".zip":
      return "application/zip";
    default:
      return undefined;
  }
}

function buildQueueKey(msg: GatewayInboundEnvelope["message"]): string {
  const thread = msg.conversation.threadId ?? "";
  return `${msg.channel}:${msg.accountId}:${msg.conversation.id}:${thread}`;
}

/**
 * Owner-chat predicate used by the dispatcher's reply gating. Matches the
 * dual check in `sender-classify.ts:classifyActivitySender` so the
 * dispatcher's gate stays consistent with the composer's owner-bypass:
 *
 *   1. `rm_oc_*` room id, OR
 *   2. `source_type === "dashboard_user_chat"` on the raw envelope.
 *
 * The latter exists because the dashboard's user-chat surface can route
 * messages through non-`rm_oc_` rooms in some flows; treating them as
 * owner-trust here keeps the agent's plain reply text reachable.
 */
function isOwnerChatRoom(msg: GatewayInboundEnvelope["message"]): boolean {
  if (msg.conversation.id.startsWith(OWNER_CHAT_ROOM_PREFIX)) return true;
  const raw = msg.raw;
  if (raw && typeof raw === "object") {
    const sourceType = (raw as { source_type?: unknown }).source_type;
    if (sourceType === "dashboard_user_chat") return true;
  }
  return false;
}

function isBotCordChannel(channel: ChannelAdapter): boolean {
  return channel.type === "botcord" || channel.id === "botcord";
}

function isMultimodalOnlyMessage(msg: GatewayInboundEnvelope["message"]): boolean {
  if (!hasMultimodalContent(msg.raw)) return false;
  return !hasAuthoredText(msg.raw);
}

function hasAuthoredText(raw: unknown): boolean {
  if (!raw || typeof raw !== "object") return false;
  const obj = raw as Record<string, unknown>;
  const batch = obj.batch;
  if (Array.isArray(batch)) return batch.some((item) => hasAuthoredText(item));

  if (typeof obj.text === "string" && obj.text.trim().length > 0) {
    // BotCord's /hub/inbox `text` may be synthesized from attachment metadata
    // when payload text is empty, so prefer envelope payload below when present.
    if (!obj.envelope || typeof obj.envelope !== "object") return true;
  }

  const envelope = obj.envelope as Record<string, unknown> | undefined;
  const payload = envelope?.payload as Record<string, unknown> | undefined;
  if (payload) {
    for (const key of ["text", "body", "message"]) {
      const value = payload[key];
      if (typeof value === "string" && value.trim().length > 0) return true;
    }
    return false;
  }

  const itemList = obj.item_list;
  if (Array.isArray(itemList)) {
    return itemList.some((item) => {
      if (!item || typeof item !== "object") return false;
      const textItem = (item as { text_item?: { text?: unknown } }).text_item;
      return typeof textItem?.text === "string" && textItem.text.trim().length > 0;
    });
  }

  return typeof obj.text === "string" && obj.text.trim().length > 0;
}

function hasMultimodalContent(raw: unknown): boolean {
  if (!raw || typeof raw !== "object") return false;
  const obj = raw as Record<string, unknown>;
  const batch = obj.batch;
  if (Array.isArray(batch)) return batch.some((item) => hasMultimodalContent(item));

  const envelope = obj.envelope as Record<string, unknown> | undefined;
  const payload = envelope?.payload as Record<string, unknown> | undefined;
  const attachments = payload?.attachments;
  if (Array.isArray(attachments) && attachments.length > 0) return true;

  const itemList = obj.item_list;
  if (Array.isArray(itemList)) {
    return itemList.some((item) => {
      if (!item || typeof item !== "object") return false;
      return (item as { type?: unknown }).type !== 1;
    });
  }

  return false;
}

function resolveQueueMode(
  route: GatewayRoute,
  kind: "direct" | "group",
): QueueMode {
  if (route.queueMode) return route.queueMode;
  return kind === "direct" ? "cancel-previous" : "serial";
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max) + "…";
}

/**
 * Single-line preview of a multi-line user/agent text, capped at `max` chars.
 * Used to embed message/reply previews in daemon.log lines without bloating
 * each line into multi-line JSON. Full text lives in transcripts.
 */
function logPreview(s: string, max: number = 120): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : flat.slice(0, max) + "…";
}
