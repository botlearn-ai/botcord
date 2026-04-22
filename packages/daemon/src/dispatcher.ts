import type { BotCordClient } from "@botcord/protocol-core";
import type { DaemonConfig, RouteRule } from "./config.js";
import { SessionStore, type SessionEntry } from "./session-store.js";
import { ClaudeCodeAdapter } from "./adapters/claude-code.js";
import type { AgentBackend } from "./adapters/types.js";
import { postStreamBlock } from "./stream-block.js";
import { log } from "./log.js";

export interface InboxEnvelope {
  msg_id: string;
  from: string;
  to: string;
  type: string;
  payload: { text?: string; [k: string]: unknown };
  reply_to?: string | null;
  topic?: string | null;
}

export interface InboxMessage {
  hub_msg_id: string;
  envelope: InboxEnvelope;
  /** Hub-extracted convenience field for text payloads. */
  text?: string | null;
  room_id?: string | null;
  room_name?: string | null;
  topic?: string | null;
  topic_id?: string | null;
  goal?: string | null;
  mentioned?: boolean;
  source_type?: string;
  source_user_id?: string | null;
  source_session_kind?: string | null;
}

const OWNER_CHAT_PREFIX = "rm_oc_";
const DEFAULT_TURN_TIMEOUT_MS = 10 * 60 * 1000;

export interface DispatcherOptions {
  /** Override per-turn hard cap. Default 10 minutes. */
  turnTimeoutMs?: number;
  /** Inject adapters (test hook). */
  adapters?: Record<string, AgentBackend>;
}

export class Dispatcher {
  private readonly adapters: Record<string, AgentBackend>;
  private readonly runningTurns = new Map<string, AbortController>();
  private readonly seenMessages = new Set<string>();
  private readonly turnTimeoutMs: number;

  constructor(
    private readonly client: BotCordClient,
    private readonly config: DaemonConfig,
    private readonly store: SessionStore,
    options?: DispatcherOptions,
  ) {
    this.adapters = options?.adapters ?? {
      "claude-code": new ClaudeCodeAdapter(),
      // codex / gemini adapters can be wired in later.
    };
    this.turnTimeoutMs = options?.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
  }

  async drainInbox(): Promise<void> {
    // Two-phase ack: pull without acking, then ack explicitly after the dispatcher
    // has accepted each message. Hub holds unacked messages in `processing` for
    // 120s before requeuing.
    const resp = await this.client.pollInbox({ limit: 50, ack: false });
    const msgs = (resp as unknown as { messages?: InboxMessage[] }).messages;
    log.info("inbox drained", { count: msgs?.length ?? 0 });
    if (!msgs || msgs.length === 0) return;

    const acceptedIds: string[] = [];
    const pendingHandlers: Array<Promise<void>> = [];

    for (const msg of msgs) {
      if (this.seenMessages.has(msg.hub_msg_id)) {
        // Already handed to dispatcher in a previous drain — ack so Hub doesn't requeue.
        acceptedIds.push(msg.hub_msg_id);
        continue;
      }
      this.seenMessages.add(msg.hub_msg_id);
      if (this.seenMessages.size > 500) {
        const first = this.seenMessages.values().next().value;
        if (first) this.seenMessages.delete(first);
      }
      // Accepted = dispatcher owns it. Ack now; the turn itself may still fail,
      // but that's reported via owner-chat error reply, not via Hub retry.
      acceptedIds.push(msg.hub_msg_id);
      pendingHandlers.push(
        this.handleMessage(msg).catch((err) =>
          log.error("dispatch turn crashed", { hubMsgId: msg.hub_msg_id, err: String(err) }),
        ),
      );
    }

    if (acceptedIds.length > 0) {
      try {
        await this.client.ackMessages(acceptedIds);
      } catch (err) {
        log.warn("ack failed — Hub will requeue; dedup via seenMessages", {
          count: acceptedIds.length,
          err: String(err),
        });
      }
    }

    // Let handlers run in the background; don't block the drain loop on them.
    void Promise.allSettled(pendingHandlers);
  }

  private async handleMessage(msg: InboxMessage): Promise<void> {
    const env = msg.envelope;
    if (!env) {
      log.warn("inbox message missing envelope", { hubMsgId: msg.hub_msg_id });
      return;
    }
    const rawText = msg.text ?? (typeof env.payload?.text === "string" ? env.payload.text : "");
    const text = typeof rawText === "string" ? rawText.trim() : "";
    if (!text) return;
    if (env.type !== "message") return;
    if (!msg.room_id) {
      log.debug("skipping message with no room_id", { hubMsgId: msg.hub_msg_id });
      return;
    }
    const isOwnerChat = msg.room_id.startsWith(OWNER_CHAT_PREFIX);
    // Owner-chat stores the "user" side with from=agentId (dashboard quirk); everywhere else,
    // from==self means it's our own echo.
    if (env.from === this.config.agentId && !isOwnerChat) return;

    const route = this.resolveRoute(msg.room_id);
    const adapter = this.adapters[route.adapter];
    if (!adapter) {
      log.warn("no adapter registered, skipping", { adapter: route.adapter });
      if (isOwnerChat) {
        await this.replyError(msg, `no adapter "${route.adapter}" configured`);
      }
      return;
    }

    const turnKey = `${msg.room_id}:${msg.topic ?? ""}`;
    const prev = this.runningTurns.get(turnKey);
    if (prev) {
      log.info("cancelling in-flight turn for room", { turnKey });
      prev.abort();
    }
    const ctrl = new AbortController();
    this.runningTurns.set(turnKey, ctrl);

    // 10-minute hard cap on any single turn.
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      log.warn("turn timed out", { turnKey, hubMsgId: msg.hub_msg_id, timeoutMs: this.turnTimeoutMs });
      ctrl.abort();
    }, this.turnTimeoutMs);
    if (typeof timer.unref === "function") timer.unref();

    const existing = this.store.get(this.config.agentId, msg.room_id, msg.topic ?? undefined);
    const sessionId = existing?.backendSid ?? null;
    const streamBlocks = this.config.streamBlocks && isOwnerChat;

    log.info("turn begin", {
      hubMsgId: msg.hub_msg_id,
      roomId: msg.room_id,
      topic: msg.topic ?? null,
      adapter: route.adapter,
      cwd: route.cwd,
      resume: sessionId,
    });

    let result: Awaited<ReturnType<AgentBackend["run"]>> | undefined;
    let threw: unknown;
    try {
      result = await adapter.run({
        text,
        sessionId,
        cwd: route.cwd,
        extraArgs: route.extraArgs,
        signal: ctrl.signal,
        onBlock: streamBlocks
          ? (block) => {
              if (block.kind === "assistant_text" || block.kind === "tool_use") {
                postStreamBlock(this.client, msg.hub_msg_id, block.seq, block.raw).catch(() => {});
              }
            }
          : undefined,
      });
    } catch (err) {
      threw = err;
      log.error("adapter run threw", { hubMsgId: msg.hub_msg_id, err: String(err) });
    } finally {
      clearTimeout(timer);
      // Only clear the slot if we still own it — a newer turn may have taken over.
      if (this.runningTurns.get(turnKey) === ctrl) {
        this.runningTurns.delete(turnKey);
      }
    }

    // Cancelled turns (superseded by a newer message) should leave session state alone
    // and skip the reply: the next turn will own the UI.
    const cancelled = ctrl.signal.aborted && !timedOut;
    if (cancelled) {
      log.info("turn cancelled — skipping reply and session write", {
        hubMsgId: msg.hub_msg_id,
        turnKey,
      });
      return;
    }

    if (timedOut) {
      if (isOwnerChat) {
        await this.replyError(msg, `turn exceeded ${Math.round(this.turnTimeoutMs / 60000)} minute hard cap; aborted`);
      }
      return;
    }

    if (threw) {
      if (isOwnerChat) {
        const hint = (threw as NodeJS.ErrnoException)?.code === "ENOENT"
          ? `${route.adapter} binary not found — set BOTCORD_CLAUDE_BIN or install Claude Code`
          : String(threw);
        await this.replyError(msg, hint);
      }
      return;
    }

    if (result?.newSessionId) {
      this.store.upsert({
        agentId: this.config.agentId,
        roomId: msg.room_id,
        topic: msg.topic ?? null,
        backend: route.adapter,
        backendSid: result.newSessionId,
        cwd: route.cwd,
        updatedAt: Date.now(),
      } satisfies SessionEntry);
    }

    if (result?.error) {
      log.warn("adapter reported error", { hubMsgId: msg.hub_msg_id, error: result.error });
      if (isOwnerChat) {
        await this.replyError(msg, result.error);
        return;
      }
    }

    const replyText = (result?.text || "").trim();
    if (!replyText) {
      log.info("turn produced no reply text", { hubMsgId: msg.hub_msg_id });
      return;
    }

    try {
      await this.client.sendMessage(msg.room_id, replyText, {
        replyTo: msg.envelope.msg_id,
        ...(msg.topic ? { topic: msg.topic } : {}),
      });
      log.info("turn replied", {
        hubMsgId: msg.hub_msg_id,
        roomId: msg.room_id,
        len: replyText.length,
        costUsd: result?.costUsd,
      });
    } catch (err) {
      log.error("sendMessage failed", { hubMsgId: msg.hub_msg_id, err: String(err) });
    }
  }

  private async replyError(msg: InboxMessage, message: string): Promise<void> {
    if (!msg.room_id) return;
    const truncated = message.length > 500 ? message.slice(0, 500) + "…" : message;
    try {
      await this.client.sendTypedMessage(msg.room_id, "error", truncated, {
        replyTo: msg.envelope?.msg_id,
        ...(msg.topic ? { topic: msg.topic } : {}),
      });
    } catch (err) {
      log.error("error reply failed", { hubMsgId: msg.hub_msg_id, err: String(err) });
    }
  }

  private resolveRoute(roomId: string): { adapter: RouteRule["adapter"]; cwd: string; extraArgs?: string[] } {
    for (const r of this.config.routes) {
      if (r.match.roomId === roomId) return { adapter: r.adapter, cwd: r.cwd, extraArgs: r.extraArgs };
      if (r.match.roomPrefix && roomId.startsWith(r.match.roomPrefix)) {
        return { adapter: r.adapter, cwd: r.cwd, extraArgs: r.extraArgs };
      }
    }
    return {
      adapter: this.config.defaultRoute.adapter,
      cwd: this.config.defaultRoute.cwd,
      extraArgs: this.config.defaultRoute.extraArgs,
    };
  }

  cancelAll(): void {
    for (const ctrl of this.runningTurns.values()) ctrl.abort();
    this.runningTurns.clear();
  }
}
