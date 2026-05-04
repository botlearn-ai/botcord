import type {
  ChannelAdapter,
  ChannelSendContext,
  ChannelSendResult,
  ChannelStartContext,
  ChannelStatusSnapshot,
  ChannelStopContext,
  ChannelTypingContext,
  GatewayInboundEnvelope,
  GatewayInboundMessage,
} from "../types.js";
import { sanitizeUntrustedContent } from "./sanitize.js";
import { GatewayStateStore } from "./state-store.js";
import { loadGatewaySecret } from "./secret-store.js";
import { splitText } from "./text-split.js";

const DEFAULT_BASE_URL = "https://api.telegram.org";
const DEFAULT_SPLIT_AT = 4000; // Telegram hard limit is 4096; leave slack.
const POLL_TIMEOUT_S = 25;
const POLL_BACKOFF_MS = 3000;
const TRANSIENT_BACKOFF_MS = 1000;
const TELEGRAM_PROVIDER = "telegram" as const;

/** Options accepted by {@link createTelegramChannel}. */
export interface TelegramChannelOptions {
  id: string;
  accountId: string;
  /** Bot token. When omitted, the adapter loads it from the secret-store on start. */
  botToken?: string;
  baseUrl?: string;
  /** Empty / missing list = default-deny. */
  allowedSenderIds?: string[];
  /** Empty / missing list = default-deny. */
  allowedChatIds?: string[];
  splitAt?: number;
  secretFile?: string;
  stateFile?: string;
  /** Test hook: override `globalThis.fetch`. */
  fetchImpl?: typeof fetch;
  /** Test hook: synchronous state writes (`debounceMs: 0`). */
  stateDebounceMs?: number;
}

interface TelegramSecret {
  botToken?: string;
  [key: string]: unknown;
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

/**
 * Telegram channel adapter — long-polls `getUpdates`, normalizes text messages
 * to `GatewayInboundEnvelope`, and writes replies via `sendMessage`. Cursor
 * (`update_id + 1`) is persisted to the state-store so a daemon restart never
 * replays the last batch.
 *
 * Allowlists are default-deny: an empty (or missing) `allowedChatIds` /
 * `allowedSenderIds` rejects every inbound message. This matches the security
 * default in the third-party-gateway design doc.
 */
export function createTelegramChannel(opts: TelegramChannelOptions): ChannelAdapter {
  const channelType = TELEGRAM_PROVIDER;
  const baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const splitAt = opts.splitAt && opts.splitAt > 0 ? opts.splitAt : DEFAULT_SPLIT_AT;
  const allowedSenderIds = new Set((opts.allowedSenderIds ?? []).map((s) => String(s)));
  const allowedChatIds = new Set((opts.allowedChatIds ?? []).map((s) => String(s)));
  const fetchImpl: typeof fetch = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);

  let botToken: string | undefined = opts.botToken;
  let started = false;

  /**
   * C3: Redact the bot token from any log/error string. Telegram's Bot API
   * embeds the token in the URL path, so fetch errors and JSON.parse failures
   * routinely include it. Replace before any log.* call.
   */
  function redactToken(input: string): string {
    if (!botToken || !input) return input;
    return input.split(botToken).join("***");
  }
  let stateStore: GatewayStateStore | null = null;
  let stopCallback: (() => void) | null = null;
  // W11: captured during start() so send() can push lastSendAt to the
  // gateway-tracked snapshot, not just the local statusSnapshot.
  let liveSetStatus:
    | ((patch: Partial<ChannelStatusSnapshot>) => void)
    | null = null;

  let statusSnapshot: ChannelStatusSnapshot = {
    channel: opts.id,
    accountId: opts.accountId,
    running: false,
    connected: false,
    reconnectAttempts: 0,
    lastError: null,
    provider: TELEGRAM_PROVIDER,
    authorized: false,
  };

  function ensureState(): GatewayStateStore {
    if (!stateStore) {
      stateStore = new GatewayStateStore(opts.id, {
        ...(opts.stateFile ? { override: opts.stateFile } : {}),
        ...(opts.stateDebounceMs !== undefined
          ? { debounceMs: opts.stateDebounceMs }
          : {}),
      });
    }
    return stateStore;
  }

  function loadTokenFromSecretIfNeeded(): string | undefined {
    if (botToken) return botToken;
    const secret = loadGatewaySecret<TelegramSecret>(opts.id, opts.secretFile);
    if (secret && typeof secret.botToken === "string" && secret.botToken.length > 0) {
      botToken = secret.botToken;
    }
    return botToken;
  }

  async function callApi<T>(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<TelegramApiResult<T>> {
    if (!botToken) throw new Error("telegram bot token not loaded");
    const url = `${baseUrl}/bot${botToken}/${method}`;
    let resp: Response;
    try {
      resp = await fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      // C3: fetch errors often stringify the URL (which embeds the token).
      // Re-raise with the token replaced.
      const e = err as Error;
      const redacted = redactToken(e.message ?? String(err));
      const next = new Error(redacted);
      next.name = e.name ?? "Error";
      throw next;
    }
    const json = (await resp.json()) as TelegramApiResult<T>;
    return json;
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

  function normalizeUpdate(update: TelegramUpdate): GatewayInboundMessage | null {
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

    // W5: default-deny is the INTERSECTION — both chatId AND senderId must
    // appear in their respective allowlists. An empty list rejects everyone.
    // TODO: surface this rule in the dashboard help text (frontend).
    if (!allowedChatIds.has(chatId)) return null;
    if (!allowedSenderIds.has(fromUserId)) return null;

    const isPrivate = chat.type === "private";
    const conversationId = isPrivate
      ? `telegram:user:${chatId}`
      : `telegram:group:${chatId}`;
    const conversationKind: "direct" | "group" = isPrivate ? "direct" : "group";

    const senderName =
      from.username ??
      [from.first_name].filter((s): s is string => typeof s === "string" && s.length > 0)[0];

    const sanitized = sanitizeUntrustedContent(text);
    const messageId = `telegram:${chatId}:${msg.message_id}`;

    return {
      id: messageId,
      channel: opts.id,
      accountId: opts.accountId,
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
      text: sanitized,
      raw: update,
      replyTo: null,
      mentioned: false,
      receivedAt: Date.now(),
      trace: { id: messageId, streamable: false },
    };
  }

  async function pollLoop(ctx: ChannelStartContext): Promise<void> {
    const { abortSignal, log, emit, setStatus } = ctx;
    liveSetStatus = setStatus;
    const state = ensureState();

    function markStatus(patch: Partial<ChannelStatusSnapshot>) {
      statusSnapshot = { ...statusSnapshot, ...patch };
      setStatus(patch);
    }

    if (!loadTokenFromSecretIfNeeded()) {
      markStatus({
        running: false,
        connected: false,
        authorized: false,
        lastError: "missing_secret",
      });
      log.error("telegram missing bot token", { gatewayId: opts.id });
      return;
    }

    let offset = 0;
    const cursor = state.getCursor();
    if (cursor) {
      const parsed = Number(cursor);
      if (Number.isFinite(parsed)) offset = parsed;
    }

    markStatus({
      running: true,
      connected: true,
      authorized: true,
      reconnectAttempts: 0,
      lastError: null,
      lastStartAt: Date.now(),
    });
    log.info("telegram poll loop starting", { gatewayId: opts.id, offset });

    let stopped = false;
    const onAbort = () => {
      stopped = true;
    };
    abortSignal.addEventListener("abort", onAbort, { once: true });
    stopCallback = () => {
      stopped = true;
    };

    while (!stopped && !abortSignal.aborted) {
      try {
        const resp = await callApi<TelegramUpdate[]>(
          "getUpdates",
          {
            offset,
            timeout: POLL_TIMEOUT_S,
            allowed_updates: ["message"],
          },
          (POLL_TIMEOUT_S + 15) * 1000,
        );
        markStatus({ lastPollAt: Date.now() });
        if (!resp.ok) {
          log.warn("telegram getUpdates non-ok", {
            description: redactToken(resp.description ?? ""),
          });
          markStatus({ lastError: redactToken(resp.description ?? "getUpdates failed") });
          await sleep(POLL_BACKOFF_MS, abortSignal);
          continue;
        }
        const updates = resp.result ?? [];
        if (updates.length === 0) continue;

        // W1: persist cursor only AFTER all emits return cleanly. If emit
        // throws, leave the cursor untouched so the same batch retries on
        // the next poll instead of being silently dropped.
        let maxId = offset - 1;
        for (const u of updates) {
          if (u.update_id > maxId) maxId = u.update_id;
        }

        let emitFailed = false;
        for (const update of updates) {
          const normalized = normalizeUpdate(update);
          if (!normalized) continue;
          markStatus({ lastInboundAt: Date.now() });
          const envelope: GatewayInboundEnvelope = { message: normalized };
          try {
            await emit(envelope);
          } catch (err) {
            emitFailed = true;
            log.error("telegram emit threw — leaving cursor unchanged", {
              err: redactToken(String(err)),
            });
            break;
          }
        }
        if (!emitFailed) {
          offset = maxId + 1;
          state.update({ cursor: String(offset) });
        }
      } catch (err) {
        if (stopped || abortSignal.aborted) break;
        const name = (err as Error)?.name ?? "";
        if (name === "AbortError" || name === "TimeoutError") {
          log.warn("telegram poll transient", { name });
          await sleep(TRANSIENT_BACKOFF_MS, abortSignal);
          continue;
        }
        log.error("telegram poll failed", { err: redactToken(String(err)) });
        markStatus({ lastError: redactToken(String(err)) });
        await sleep(POLL_BACKOFF_MS, abortSignal);
      }
    }

    markStatus({
      running: false,
      connected: false,
      lastStopAt: Date.now(),
    });
    try {
      state.flush();
    } catch (e) {
      log.warn("state-flush-on-stop failed", { error: String(e) });
    }
  }

  const adapter: ChannelAdapter = {
    id: opts.id,
    type: channelType,

    async start(ctx: ChannelStartContext): Promise<void> {
      if (started) throw new Error("already started");
      started = true;
      await pollLoop(ctx);
    },

    async stop(_ctx: ChannelStopContext): Promise<void> {
      if (stopCallback) {
        stopCallback();
        stopCallback = null;
      }
      try {
        stateStore?.flush();
      } catch (e) {
        // W7: log flush failures at stop — previously swallowed silently.
        console.warn("[telegram] state-flush-on-stop failed", String(e));
      }
    },

    async send(ctx: ChannelSendContext): Promise<ChannelSendResult> {
      const { message, log } = ctx;
      if (!loadTokenFromSecretIfNeeded()) {
        throw new Error("telegram bot token not loaded");
      }
      const chatId = chatIdFromConversation(message.conversationId);
      if (!chatId) {
        throw new Error(
          `telegram send: unrecognized conversationId "${message.conversationId}"`,
        );
      }
      const chunks = splitText(message.text, splitAt);
      let lastMessageId: string | null = null;
      for (const chunk of chunks) {
        const resp = await callApi<TelegramMessage>(
          "sendMessage",
          {
            chat_id: chatId,
            text: chunk,
            disable_web_page_preview: true,
          },
          15_000,
        );
        if (!resp.ok) {
          log.warn("telegram sendMessage non-ok", {
            description: redactToken(resp.description ?? ""),
          });
          throw new Error(
            `telegram sendMessage failed: ${redactToken(resp.description ?? "unknown")}`,
          );
        }
        if (resp.result?.message_id !== undefined) {
          lastMessageId = `telegram:${chatId}:${resp.result.message_id}`;
        }
      }
      const sendAt = Date.now();
      statusSnapshot = { ...statusSnapshot, lastSendAt: sendAt };
      // W11: push to the gateway snapshot too — the dashboard reads this.
      if (liveSetStatus) liveSetStatus({ lastSendAt: sendAt });
      return { providerMessageId: lastMessageId };
    },

    async typing(ctx: ChannelTypingContext): Promise<void> {
      if (!loadTokenFromSecretIfNeeded()) return;
      const chatId = chatIdFromConversation(ctx.conversationId);
      if (!chatId) return;
      try {
        await callApi("sendChatAction", { chat_id: chatId, action: "typing" }, 10_000);
      } catch (err) {
        ctx.log.warn("telegram typing failed", { err: redactToken(String(err)) });
      }
    },

    status(): ChannelStatusSnapshot {
      return { ...statusSnapshot };
    },
  };

  return adapter;
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

