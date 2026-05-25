import type { GatewayInboundMessage } from "@botcord/protocol-core";
import type { OutboundSendRequest, OutboundSendResult } from "../types.js";
import type { ProviderAdapter, ProviderAdapterFactory, ProviderRuntimeContext } from "./types.js";

/**
 * Telegram getUpdates polling adapter for the cloud gateway ingress.
 *
 * Cursor (`update_id + 1`) is owned by the ingress orchestrator —
 * `ProviderRuntimeContext.persistCursor` is called only after every
 * message in a batch has been durably written via `emit`. This is the
 * `do not advance cursor until durable owner` invariant from the
 * design doc §6.1.
 *
 * The adapter intentionally avoids the daemon-side allowlists field
 * for now (MVP) — Hub-managed gateway rows already gate provider use
 * per agent; whitelists per chat / sender can layer on later.
 */
const DEFAULT_BASE_URL = "https://api.telegram.org";
const DEFAULT_SPLIT_AT = 4000;
const POLL_TIMEOUT_S = 25;
const POLL_BACKOFF_MS = 3000;
const TRANSIENT_BACKOFF_MS = 1000;

interface TelegramSecret {
  botToken?: string;
}

interface TelegramUser {
  id: number;
  is_bot?: boolean;
  username?: string;
  first_name?: string;
}

interface TelegramChat {
  id: number;
  type: "private" | "group" | "supergroup" | "channel";
  title?: string;
}

interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  text?: string;
  date?: number;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

interface TelegramApiResult<T> {
  ok: boolean;
  result?: T;
  description?: string;
}

export interface TelegramProviderOptions {
  gatewayId: string;
  /** Test hook: override `globalThis.fetch`. */
  fetchImpl?: typeof fetch;
  /** Test hook: shorter poll interval. */
  pollTimeoutSeconds?: number;
}

export function createTelegramProvider(opts: TelegramProviderOptions): ProviderAdapter {
  const fetchImpl: typeof fetch = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const pollTimeoutSeconds = opts.pollTimeoutSeconds ?? POLL_TIMEOUT_S;

  let stopController: AbortController | null = null;
  let activeCtx: ProviderRuntimeContext | null = null;
  let botToken: string | undefined;
  let baseUrl = DEFAULT_BASE_URL;
  let splitAt = DEFAULT_SPLIT_AT;
  let allowedSenderIds = new Set<string>();
  let allowedChatIds = new Set<string>();

  function redactToken(input: string): string {
    if (!botToken || !input) return input;
    return input.split(botToken).join("***");
  }

  async function callApi<T>(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<TelegramApiResult<T>> {
    if (!botToken) throw new Error("telegram bot token not loaded");
    const url = `${baseUrl}/bot${botToken}/${method}`;
    const lease = createTimeoutSignal(timeoutMs, signal);
    let resp: Response;
    try {
      resp = await fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params),
        signal: lease.signal,
      });
    } catch (err) {
      const e = err as Error;
      const next = new Error(redactToken(e.message ?? String(err)));
      next.name = e.name ?? "Error";
      throw next;
    } finally {
      lease.cleanup();
    }
    return (await resp.json()) as TelegramApiResult<T>;
  }

  function chatIdFromConversation(conversationId: string): string | null {
    if (conversationId.startsWith("telegram:user:")) {
      return conversationId.slice("telegram:user:".length);
    }
    if (conversationId.startsWith("telegram:group:")) {
      return conversationId.slice("telegram:group:".length);
    }
    return null;
  }

  function normalizeUpdate(
    update: TelegramUpdate,
    accountId: string,
    channelId: string,
  ): GatewayInboundMessage | null {
    const msg = update.message;
    if (!msg) return null;
    const text = typeof msg.text === "string" ? msg.text : null;
    if (text === null) return null;
    const from = msg.from;
    if (!from) return null;
    const chat = msg.chat;
    if (!chat) return null;

    const fromUserId = String(from.id);
    const chatId = String(chat.id);

    if (allowedChatIds.size > 0 && !allowedChatIds.has(chatId)) return null;
    if (allowedSenderIds.size > 0 && !allowedSenderIds.has(fromUserId)) return null;

    const isPrivate = chat.type === "private";
    const conversationId = isPrivate ? `telegram:user:${chatId}` : `telegram:group:${chatId}`;
    const conversationKind: "direct" | "group" = isPrivate ? "direct" : "group";
    const senderName =
      from.username ?? from.first_name ?? undefined;
    const messageId = `telegram:${chatId}:${msg.message_id}`;

    const normalized: GatewayInboundMessage = {
      id: messageId,
      channel: channelId,
      accountId,
      conversation: {
        id: conversationId,
        kind: conversationKind,
        ...(chat.title ? { title: chat.title } : {}),
      },
      sender: {
        id: `telegram:user:${fromUserId}`,
        ...(senderName ? { name: senderName } : {}),
        kind: "user",
      },
      text,
      replyTo: null,
      mentioned: false,
      receivedAt: Date.now(),
      trace: { id: messageId, streamable: true },
    };
    return normalized;
  }

  async function loop(ctx: ProviderRuntimeContext): Promise<void> {
    activeCtx = ctx;
    const secret = ctx.secret as TelegramSecret;
    botToken = secret.botToken;
    const config = ctx.connection.config as {
      baseUrl?: string;
      splitAt?: number;
      allowedSenderIds?: string[];
      allowedChatIds?: string[];
    };
    if (config.baseUrl) baseUrl = config.baseUrl.replace(/\/+$/, "");
    if (config.splitAt && config.splitAt > 0) splitAt = config.splitAt;
    allowedSenderIds = new Set((config.allowedSenderIds ?? []).map(String));
    allowedChatIds = new Set((config.allowedChatIds ?? []).map(String));

    if (!botToken) {
      ctx.log.error("telegram bot token missing", { gatewayId: ctx.connection.id });
      ctx.markActivity({ lastError: "missing_secret" });
      return;
    }

    stopController = new AbortController();
    const abortAggregate = new AbortController();
    if (ctx.abortSignal.aborted) {
      abortAggregate.abort();
    } else {
      ctx.abortSignal.addEventListener("abort", () => abortAggregate.abort(), { once: true });
    }
    stopController.signal.addEventListener("abort", () => abortAggregate.abort(), { once: true });

    let offset = Number(((ctx.loadCursor() as { offset?: number }).offset ?? 0)) || 0;

    while (!abortAggregate.signal.aborted) {
      try {
        const resp = await callApi<TelegramUpdate[]>(
          "getUpdates",
          {
            offset,
            timeout: pollTimeoutSeconds,
            allowed_updates: ["message"],
          },
          (pollTimeoutSeconds + 15) * 1000,
          abortAggregate.signal,
        );
        ctx.markActivity({ lastPollAt: Date.now() });
        if (!resp.ok) {
          ctx.log.warn("telegram getUpdates non-ok", {
            description: redactToken(resp.description ?? ""),
          });
          ctx.markActivity({ lastError: redactToken(resp.description ?? "getUpdates failed") });
          await sleep(POLL_BACKOFF_MS, abortAggregate.signal);
          continue;
        }
        const updates = resp.result ?? [];
        if (updates.length === 0) continue;

        let maxId = offset - 1;
        for (const u of updates) {
          if (u.update_id > maxId) maxId = u.update_id;
        }

        let failed = false;
        for (const update of updates) {
          const normalized = normalizeUpdate(update, ctx.connection.agentId, ctx.connection.id);
          if (!normalized) continue;
          ctx.markActivity({ lastInboundAt: Date.now() });
          const providerEventId = `tg:${ctx.connection.id}:${update.update_id}`;
          try {
            await ctx.emit(normalized, providerEventId);
          } catch (err) {
            failed = true;
            ctx.log.error("telegram emit threw — keeping cursor", {
              err: redactToken(String(err)),
            });
            break;
          }
        }
        if (!failed) {
          offset = maxId + 1;
          ctx.persistCursor({ offset });
        }
      } catch (err) {
        if (abortAggregate.signal.aborted) break;
        const name = (err as Error)?.name ?? "";
        if (name === "AbortError" || name === "TimeoutError") {
          await sleep(TRANSIENT_BACKOFF_MS, abortAggregate.signal);
          continue;
        }
        ctx.log.error("telegram poll failed", { err: redactToken(String(err)) });
        ctx.markActivity({ lastError: redactToken(String(err)) });
        await sleep(POLL_BACKOFF_MS, abortAggregate.signal);
      }
    }
  }

  async function send(request: OutboundSendRequest): Promise<OutboundSendResult> {
    if (!botToken) throw new Error("telegram bot token not loaded");
    const chatId = chatIdFromConversation(request.conversationId);
    if (!chatId) {
      throw new Error(
        `telegram send: unrecognized conversationId "${request.conversationId}"`,
      );
    }
    const chunks = splitText(request.text, splitAt);
    let lastMessageId: string | null = null;
    for (const chunk of chunks) {
      const resp = await callApi<TelegramMessage>(
        "sendMessage",
        { chat_id: chatId, text: chunk, disable_web_page_preview: true },
        15_000,
      );
      if (!resp.ok) {
        throw new Error(
          `telegram sendMessage failed: ${redactToken(resp.description ?? "unknown")}`,
        );
      }
      if (resp.result?.message_id !== undefined) {
        lastMessageId = `telegram:${chatId}:${resp.result.message_id}`;
      }
    }
    if (activeCtx) {
      activeCtx.markActivity({ lastInboundAt: undefined });
    }
    return { providerMessageId: lastMessageId };
  }

  return {
    gatewayId: opts.gatewayId,
    provider: "telegram",
    async start(ctx) {
      await loop(ctx);
    },
    async stop(_reason) {
      stopController?.abort();
    },
    send,
  };
}

/** Factory used by `ProviderRunner.registerFactory("telegram", …)`. */
export const telegramProviderFactory: ProviderAdapterFactory = (gatewayId) =>
  createTelegramProvider({ gatewayId });

// ---------------------------------------------------------------------------
// Local helpers — paragraph-aware splitter (different algorithm from the
// canonical `splitText` in `@botcord/protocol-core`, which cuts on single
// newlines). Kept local because Telegram replies benefit from preserving
// paragraph boundaries when the daemon-style cutter would break mid-paragraph.
// ---------------------------------------------------------------------------

function splitText(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];
  const out: string[] = [];
  let buf = "";
  for (const para of text.split(/\n\n/)) {
    if (buf.length + para.length + 2 > limit) {
      if (buf) out.push(buf);
      if (para.length > limit) {
        // Hard-split a paragraph that exceeds the limit by itself.
        for (let i = 0; i < para.length; i += limit) {
          out.push(para.slice(i, i + limit));
        }
        buf = "";
      } else {
        buf = para;
      }
    } else {
      buf = buf ? `${buf}\n\n${para}` : para;
    }
  }
  if (buf) out.push(buf);
  return out;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function createTimeoutSignal(
  timeoutMs: number,
  parent?: AbortSignal,
): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  let settled = false;
  const abort = (reason?: unknown) => {
    if (settled) return;
    settled = true;
    try {
      controller.abort(reason);
    } catch {
      controller.abort();
    }
  };
  const timer = setTimeout(() => abort(new DOMException("Timeout", "TimeoutError")), timeoutMs);
  const onParent = () => abort(parent?.reason);
  if (parent) {
    if (parent.aborted) onParent();
    else parent.addEventListener("abort", onParent, { once: true });
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      if (parent) parent.removeEventListener("abort", onParent);
    },
  };
}
