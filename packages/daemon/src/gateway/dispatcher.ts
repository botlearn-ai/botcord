import type { GatewayLogger } from "./log.js";
import { resolveRoute } from "./router.js";
import { sessionKey, type SessionStore } from "./session-store.js";
import type {
  ChannelAdapter,
  GatewayConfig,
  GatewayInboundEnvelope,
  GatewayOutboundMessage,
  GatewayRoute,
  GatewaySessionEntry,
  InboundObserver,
  QueueMode,
  RuntimeAdapter,
  StreamBlock,
  SystemContextBuilder,
  TurnStatusSnapshot,
} from "./types.js";

const DEFAULT_TURN_TIMEOUT_MS = 10 * 60 * 1000;

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
}

interface TurnSlot {
  controller: AbortController;
  timedOut: boolean;
  snapshot: TurnStatusSnapshot;
  done: Promise<void>;
}

interface QueueState {
  /** The currently executing turn on this queue key, if any. */
  current: TurnSlot | null;
  /** Tail of the serial-mode queue — chained via promises; replaced each append. */
  tail: Promise<void>;
  /**
   * Generation counter bumped every time a cancel-previous turn arrives.
   * Any in-flight cancel-previous arrival captures the value at entry; if a
   * newer arrival bumps the counter while it's still awaiting the prior
   * turn's teardown, the older one observes the mismatch and drops out. This
   * closes the race where two cancel-previous calls could both observe
   * `current === null` after an abort and run concurrently.
   */
  cancelGen: number;
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
  private readonly managedRoutes?: Map<string, GatewayRoute>;
  private readonly queues: Map<string, QueueState> = new Map();

  constructor(opts: DispatcherOptions) {
    this.config = opts.config;
    this.channels = opts.channels;
    this.runtimeFactory = opts.runtime;
    this.sessionStore = opts.sessionStore;
    this.log = opts.log;
    this.turnTimeoutMs = opts.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
    this.buildSystemContext = opts.buildSystemContext;
    this.onInbound = opts.onInbound;
    this.managedRoutes = opts.managedRoutes;
  }

  /** Consume one inbound envelope, ack it once ownership is decided, then run its turn. */
  async handle(envelope: GatewayInboundEnvelope): Promise<void> {
    const msg = envelope.message;

    // Skip rule: empty/whitespace text.
    const text = typeof msg.text === "string" ? msg.text.trim() : "";
    if (!text) {
      this.log.debug("dispatcher skip: empty text", { messageId: msg.id });
      await this.safeAck(envelope);
      return;
    }

    // Skip rule: echo from the agent itself (own agent output looped back).
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

    // Ack immediately: once the dispatcher has a route + queue key, ownership is decided.
    await this.safeAck(envelope);

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

    const channel = this.channels.get(msg.channel);
    if (!channel) {
      this.log.warn("dispatcher: unknown channel for outbound reply", {
        channel: msg.channel,
        messageId: msg.id,
      });
      return;
    }

    if (mode === "cancel-previous") {
      await this.runCancelPrevious(queueKey, route, text, msg, channel);
    } else {
      await this.runSerial(queueKey, route, text, msg, channel);
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
        tail: Promise.resolve(),
        cancelGen: 0,
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
  ): Promise<void> {
    const q = this.getQueue(queueKey);
    // Bump the generation on every arrival. Older arrivals still awaiting
    // the prior turn's teardown will observe `myGen !== q.cancelGen` when
    // they resume and drop out, so only the newest message reaches runTurn.
    q.cancelGen += 1;
    const myGen = q.cancelGen;
    const prev = q.current;
    if (prev) {
      this.log.info("dispatcher: cancelling previous turn", { queueKey });
      prev.controller.abort();
      // Wait for it to finish cleanup (it won't reply, won't persist).
      await prev.done.catch(() => undefined);
    }
    // After the await, a newer cancel-previous may have arrived and either
    // already fired its own abort + runTurn, or be mid-await itself. If so,
    // drop out silently — the newest turn is the only one that should run.
    if (myGen !== q.cancelGen) {
      this.log.info("dispatcher: cancel-previous superseded", { queueKey });
      return;
    }
    await this.runTurn(queueKey, route, text, msg, channel);
  }

  private async runSerial(
    queueKey: string,
    route: GatewayRoute,
    text: string,
    msg: GatewayInboundEnvelope["message"],
    channel: ChannelAdapter,
  ): Promise<void> {
    const q = this.getQueue(queueKey);
    const prev = q.tail;
    const next = prev.then(() => this.runTurn(queueKey, route, text, msg, channel));
    q.tail = next.catch(() => undefined);
    return next;
  }

  private async runTurn(
    queueKey: string,
    route: GatewayRoute,
    text: string,
    msg: GatewayInboundEnvelope["message"],
    channel: ChannelAdapter,
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
    const slot: TurnSlot = { controller, timedOut: false, snapshot, done };
    q.current = slot;

    // Hard-cap turn with a timeout.
    const timer = setTimeout(() => {
      slot.timedOut = true;
      this.log.warn("dispatcher: turn timed out", {
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
    const canStream =
      streamable && typeof traceId === "string" && typeof channel.streamBlock === "function";
    const onBlock = canStream
      ? (block: StreamBlock) => {
          // Fire-and-forget: stream errors must not break the turn.
          channel
            .streamBlock!({
              traceId: traceId!,
              accountId: msg.accountId,
              conversationId: msg.conversation.id,
              block,
              log: this.log,
            })
            .catch((err) => {
              this.log.warn("dispatcher: streamBlock failed", {
                traceId,
                error: err instanceof Error ? err.message : String(err),
              });
            });
        }
      : undefined;

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
          extraArgs: route.extraArgs,
          signal: controller.signal,
          trustLevel,
          systemContext,
          onBlock,
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
      if (controller.signal.aborted && !slot.timedOut) {
        return;
      }

      if (slot.timedOut) {
        await this.sendReply(channel, {
          channel: msg.channel,
          accountId: msg.accountId,
          conversationId: msg.conversation.id,
          threadId: msg.conversation.threadId ?? null,
          text: `⚠️ Runtime timeout after ${Math.round(this.turnTimeoutMs / 60000)} minute(s); aborted`,
          replyTo: msg.id,
          traceId: msg.trace?.id ?? null,
        });
        return;
      }

      if (threw) {
        this.log.error("dispatcher: runtime threw", {
          queueKey,
          runtime: route.runtime,
          error: threw instanceof Error ? threw.message : String(threw),
        });
        const shortMsg = threw instanceof Error ? threw.message : String(threw);
        await this.sendReply(channel, {
          channel: msg.channel,
          accountId: msg.accountId,
          conversationId: msg.conversation.id,
          threadId: msg.conversation.threadId ?? null,
          text: `⚠️ Runtime error: ${truncate(shortMsg, 500)}`,
          replyTo: msg.id,
          traceId: msg.trace?.id ?? null,
        });
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
      if (!replyText) return;

      // One last abort check immediately before the send. Narrows the window
      // in which a cancel-previous arriving during session-store.set could
      // still slip a stale reply past us.
      if (controller.signal.aborted && !slot.timedOut) {
        return;
      }

      await this.sendReply(channel, {
        channel: msg.channel,
        accountId: msg.accountId,
        conversationId: msg.conversation.id,
        threadId: msg.conversation.threadId ?? null,
        text: replyText,
        replyTo: msg.id,
        traceId: msg.trace?.id ?? null,
      });
    } finally {
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
  ): Promise<void> {
    try {
      await channel.send({ message: outbound, log: this.log });
    } catch (err) {
      this.log.warn("dispatcher: channel.send failed", {
        channel: outbound.channel,
        conversationId: outbound.conversationId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

function buildQueueKey(msg: GatewayInboundEnvelope["message"]): string {
  const thread = msg.conversation.threadId ?? "";
  return `${msg.channel}:${msg.accountId}:${msg.conversation.id}:${thread}`;
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
