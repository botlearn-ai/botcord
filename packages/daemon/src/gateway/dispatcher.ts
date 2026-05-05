import { randomUUID } from "node:crypto";

import type { GatewayLogger } from "./log.js";
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
  OutboundObserver,
  QueueMode,
  RuntimeAdapter,
  RuntimeStatusEvent,
  StreamBlock,
  SystemContextBuilder,
  TurnStatusSnapshot,
  UserTurnBuilder,
} from "./types.js";

const DEFAULT_TURN_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Owner-chat room prefix. Reply-text gating: only rooms with this prefix get
 * `result.text` forwarded to the channel; in every other room the runtime's
 * plain text output is discarded — agents must use the `botcord_send` tool
 * (or `botcord send` CLI via Bash) to actually deliver replies.
 */
const OWNER_CHAT_ROOM_PREFIX = "rm_oc_";

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

/** LRU cap on the typing-recency map so long-running daemons don't grow unbounded. */
const TYPING_RECENCY_CAP = 1024;

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
  private readonly buildSystemContext?: SystemContextBuilder;
  private readonly onInbound?: InboundObserver;
  private readonly onOutbound?: OutboundObserver;
  private readonly composeUserTurn?: UserTurnBuilder;
  private readonly managedRoutes?: Map<string, GatewayRoute>;
  private readonly attentionGate?: (
    message: GatewayInboundMessage,
  ) => Promise<boolean> | boolean;
  private readonly resolveHubUrl?: (accountId: string) => string | undefined;
  private readonly transcript: TranscriptWriter;
  private readonly queues: Map<string, QueueState> = new Map();
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
    this.buildSystemContext = opts.buildSystemContext;
    this.onInbound = opts.onInbound;
    this.onOutbound = opts.onOutbound;
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

    const managed = this.managedRoutes ? Array.from(this.managedRoutes.values()) : undefined;
    const route = resolveRoute(msg, this.config, managed);
    const mode = resolveQueueMode(route, msg.conversation.kind);
    const queueKey = buildQueueKey(msg);

    // Compose the final user-turn text only for cancel-previous mode, where
    // the dispatcher consumes the pre-composed text directly. Serial mode
    // re-runs the composer at drain time on the merged message (so it sees
    // the full coalesced batch instead of any single arrival), so calling
    // the composer here would just be redundant work.
    let text = rawText;
    let composeFailedError: string | undefined;
    if (mode === "cancel-previous" && this.composeUserTurn) {
      try {
        const composed = this.composeUserTurn(msg);
        if (typeof composed === "string" && composed.length > 0) {
          text = composed;
        }
      } catch (err) {
        composeFailedError = err instanceof Error ? err.message : String(err);
        this.log.warn("dispatcher: composeUserTurn threw — using raw text", {
          messageId: msg.id,
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
        const result = this.attentionGate(msg);
        wake = result instanceof Promise ? await result : result;
      } catch (err) {
        this.log.warn("dispatcher: attentionGate threw — waking", {
          messageId: msg.id,
          error: err instanceof Error ? err.message : String(err),
        });
        wake = true;
      }
      if (!wake) {
        this.log.debug("dispatcher skip turn: attention policy", {
          messageId: msg.id,
          accountId: msg.accountId,
          conversationId: msg.conversation.id,
        });
        this.transcript.write({
          ts: nowIso(),
          kind: "attention_skipped",
          turnId,
          agentId: msg.accountId,
          roomId: msg.conversation.id,
          topicId: msg.conversation.threadId ?? null,
          reason: "attention_gate_false",
        });
        return;
      }
    }

    if (composeFailedError) {
      this.transcript.write({
        ts: nowIso(),
        kind: "compose_failed",
        turnId,
        agentId: msg.accountId,
        roomId: msg.conversation.id,
        topicId: msg.conversation.threadId ?? null,
        error: composeFailedError,
        fallback: "raw_text",
      });
    }

    if (mode === "cancel-previous") {
      await this.runCancelPrevious(queueKey, route, text, msg, channel, turnId);
    } else {
      await this.runSerial(queueKey, route, text, msg, channel, turnId);
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

  private async runCancelPrevious(
    queueKey: string,
    route: GatewayRoute,
    text: string,
    msg: GatewayInboundEnvelope["message"],
    channel: ChannelAdapter,
    turnId: string,
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
    await this.runTurn(queueKey, route, text, msg, channel, turnId, []);
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
        const mergedFromTurnIds =
          drained.length > 1 ? drained.slice(0, -1).map((e) => e.turnId) : [];
        await this.runTurn(
          queueKey,
          merged.route,
          merged.text,
          merged.msg,
          merged.channel,
          merged.turnId,
          mergedFromTurnIds,
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
    const mergedMsg: GatewayInboundEnvelope["message"] = {
      ...latest.msg,
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

    // Hard-cap turn with a timeout.
    const timer = setTimeout(() => {
      slot.timedOut = true;
      this.log.warn("dispatcher: turn timed out", {
        agentId: msg.accountId,
        roomId: msg.conversation.id,
        topicId: msg.conversation.threadId ?? null,
        turnId,
        queueKey,
        timeoutMs: this.turnTimeoutMs,
      });
      controller.abort();
    }, this.turnTimeoutMs);
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
    const trustLevel = route.trustLevel ?? "trusted";

    const streamable = msg.trace?.streamable === true;
    const traceId = msg.trace?.id;
    const canType =
      streamable && typeof traceId === "string" && typeof channel.typing === "function";
    const canStream =
      streamable && typeof traceId === "string" && typeof channel.streamBlock === "function";
    const recordBlock = (block: StreamBlock): void => {
      const summary: TranscriptBlockSummary = { type: block.kind };
      const raw = block.raw as { text?: unknown; name?: unknown } | null | undefined;
      if (raw && typeof raw === "object") {
        if (typeof raw.text === "string") summary.chars = raw.text.length;
        if (typeof raw.name === "string") summary.name = raw.name;
      }
      slot.blocks.push(summary);
    };

    // Owner-chat lifecycle state for typing/thinking. The dispatcher is the
    // only component that sees turn boundaries + channel capabilities + trace
    // ids together, so it owns the收束: once `typing.started` fires we never
    // re-fire it within this turn (frontend clears via stream/message
    // arrival), and `thinking` is auto-synthesized on the first non-assistant
    // block so adapters that emit nothing-but-blocks still drive the
    // "Thinking..." UI.
    let typingFired = false;
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

    const fireTypingIfNeeded = (): void => {
      if (!canType || typingFired) return;
      typingFired = true;
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

    const onStatus = canStream
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

    const onBlock = canStream
      ? (block: StreamBlock) => {
          // Always record adapter-emitted blocks for transcript fidelity, even
          // after abort — the transcript reflects what the runtime emitted,
          // not what the dispatcher chose to forward.
          recordBlock(block);
          if (controller.signal.aborted) return;
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
          forwardBlockToChannel!(block);
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

    const runtime = this.runtimeFactory(route.runtime, route.extraArgs);
    let result: { text: string; newSessionId: string; costUsd?: number; error?: string } | undefined;
    let threw: unknown;
    try {
      try {
        result = await runtime.run({
          text,
          sessionId,
          cwd: route.cwd,
          accountId: msg.accountId,
          hubUrl: this.resolveHubUrl?.(msg.accountId),
          extraArgs: route.extraArgs,
          signal: controller.signal,
          trustLevel,
          systemContext,
          onBlock,
          onStatus,
          gateway: route.gateway,
          ...(route.hermesProfile ? { hermesProfile: route.hermesProfile } : {}),
        });
      } catch (err) {
        threw = err;
      } finally {
        clearTimeout(timer);
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
      if (controller.signal.aborted && !slot.timedOut) {
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

      if (slot.timedOut) {
        this.transcript.write({
          ts: nowIso(),
          kind: "turn_error",
          turnId,
          agentId: msg.accountId,
          roomId: msg.conversation.id,
          topicId: msg.conversation.threadId ?? null,
          phase: "timeout",
          error: `runtime timeout after ${this.turnTimeoutMs}ms`,
          durationMs: Date.now() - slot.dispatchedAt,
        });
        if (canDeliverRuntimeText) {
          await this.sendReply(channel, {
            channel: msg.channel,
            accountId: msg.accountId,
            conversationId: msg.conversation.id,
            threadId: msg.conversation.threadId ?? null,
            text: `⚠️ Runtime timeout after ${Math.round(this.turnTimeoutMs / 60000)} minute(s); aborted`,
            replyTo: msg.id,
            traceId: msg.trace?.id ?? null,
          }, turnId);
        } else {
          this.log.warn("dispatcher: timeout in non-owner-chat room — error reply suppressed", {
            agentId: msg.accountId,
            roomId: msg.conversation.id,
            topicId: msg.conversation.threadId ?? null,
            turnId,
            queueKey,
            timeoutMs: this.turnTimeoutMs,
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
        if (canDeliverRuntimeText) {
          await this.sendReply(channel, {
            channel: msg.channel,
            accountId: msg.accountId,
            conversationId: msg.conversation.id,
            threadId: msg.conversation.threadId ?? null,
            text: `⚠️ Runtime error: ${truncate(errMsg, 500)}`,
            replyTo: msg.id,
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

      // Persist session before reply so next turn sees the new id even if send fails.
      //
      // Adapter contract:
      //   result.newSessionId truthy  → upsert the entry
      //   result.newSessionId empty + had-inbound-sessionId + result.error
      //                               → the prior session is dead (e.g. Claude Code
      //                                 "--resume <missing-uuid>"); delete the entry so
      //                                 we don't keep resuming a stale id every turn
      //   otherwise                   → no-op (e.g. codex intentionally never persists)
      if (result.newSessionId) {
        const session: GatewaySessionEntry = {
          key,
          runtime: route.runtime,
          runtimeSessionId: result.newSessionId,
          channel: msg.channel,
          accountId: msg.accountId,
          conversationKind: msg.conversation.kind,
          conversationId: msg.conversation.id,
          threadId: msg.conversation.threadId ?? null,
          cwd: route.cwd,
          updatedAt: Date.now(),
        };
        try {
          const prevRuntimeSessionId = sessionId;
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
      } else if (sessionId && result.error) {
        try {
          await this.sessionStore.delete(key);
          this.log.info("dispatcher: dropped stale runtime session", {
            key,
            prevRuntimeSessionId: sessionId,
            error: result.error,
          });
        } catch (err) {
          this.log.warn("dispatcher: session-store.delete failed", {
            key,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      const replyText = (result.text || "").trim();
      const finalTextField = truncateTextField(result.text || "");

      if (!replyText) {
        if (result.error) {
          this.log.warn("dispatcher: runtime returned error without reply text", {
            agentId: msg.accountId,
            roomId: msg.conversation.id,
            topicId: msg.conversation.threadId ?? null,
            turnId,
            runtime: route.runtime,
            error: result.error,
          });
          if (canDeliverRuntimeText) {
            const sendResult = await this.sendReply(channel, {
              channel: msg.channel,
              accountId: msg.accountId,
              conversationId: msg.conversation.id,
              threadId: msg.conversation.threadId ?? null,
              text: `⚠️ Runtime error: ${truncate(result.error, 500)}`,
              replyTo: msg.id,
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
          deliveryReason: result.error ?? null,
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

      const sendResult = await this.sendReply(channel, {
        channel: msg.channel,
        accountId: msg.accountId,
        conversationId: msg.conversation.id,
        threadId: msg.conversation.threadId ?? null,
        text: replyText,
        replyTo: msg.id,
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
