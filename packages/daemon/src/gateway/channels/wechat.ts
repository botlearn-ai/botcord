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
import { wechatHeaders, WECHAT_BASE_INFO, type FetchLike } from "./wechat-http.js";
import { randomUUID } from "node:crypto";

const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";

/**
 * Replace every occurrence of `token` in `input` with `"[REDACTED]"`.
 * No-ops when token is falsy (not yet loaded).
 */
function redactSecret(input: string, token: string | undefined): string {
  if (!token || !input) return input;
  return input.split(token).join("[REDACTED]");
}
const DEFAULT_SPLIT_AT = 1800;
/** iLink server holds getupdates ≤35s; allow slack on the client timeout. */
const POLL_TIMEOUT_S = 60;
const POLL_BACKOFF_MS = 3000;
const TRANSIENT_BACKOFF_MS = 1000;
const WECHAT_PROVIDER = "wechat" as const;
/** Trace -> context_token cache TTL. Doc recommends 30 minutes. */
const TRACE_CONTEXT_TTL_MS = 30 * 60 * 1000;
const TRACE_CONTEXT_SWEEP_MS = 5 * 60 * 1000;
/** W1: hard cap on the traceContexts map to prevent unbounded growth. */
const TRACE_CONTEXT_MAX = 5000;

/** Options accepted by {@link createWechatChannel}. */
export interface WechatChannelOptions {
  id: string;
  accountId: string;
  /** iLink bot token. When omitted, the adapter loads it from the secret-store on start. */
  botToken?: string;
  baseUrl?: string;
  /** Empty / missing list = default-deny (per security doc §"入站白名单"). */
  allowedSenderIds?: string[];
  splitAt?: number;
  secretFile?: string;
  stateFile?: string;
  /** Test hook: override `globalThis.fetch`. */
  fetchImpl?: FetchLike;
  /** Test hook: synchronous state writes (`debounceMs: 0`). */
  stateDebounceMs?: number;
  /** Test hook: override Date.now() for trace cache TTL assertions. */
  now?: () => number;
}

interface WechatSecret {
  botToken?: string;
  [key: string]: unknown;
}

interface WechatItem {
  type?: number;
  text_item?: { text?: string };
  [k: string]: unknown;
}

interface WechatInboundMsg {
  message_type?: number;
  message_state?: number;
  from_user_id?: string;
  to_user_id?: string;
  context_token?: string;
  client_id?: unknown;
  item_list?: WechatItem[];
  [k: string]: unknown;
}

interface WechatGetUpdatesResp {
  ret?: number;
  get_updates_buf?: string;
  msgs?: WechatInboundMsg[];
  [k: string]: unknown;
}

interface WechatGenericResp {
  ret?: number;
  [k: string]: unknown;
}

interface TraceContext {
  contextToken: string;
  fromUserId: string;
  updatedAt: number;
}

/**
 * WeChat (iLink Bot API) channel adapter.
 *
 *   - long-polls `POST /ilink/bot/getupdates` (cursor = `get_updates_buf`,
 *     persisted via state-store)
 *   - normalizes `message_type === 1` text into a `GatewayInboundEnvelope`
 *     with `conversation.id = "wechat:user:${fromUserId}"` and trace id
 *     `wechat:${fromUserId}:${receivedAt}` (or `client_id` when present)
 *   - per-trace cache binds `traceId → context_token`; `send()` looks up by
 *     `GatewayOutboundMessage.traceId` and rejects if missing/expired
 *     (no conversation-level fallback — see doc §"WeChat channel adapter")
 *   - `send()` splits long replies at `splitAt` (default 1800), preferring
 *     newline boundaries; `typing()` caches the per-user `typing_ticket`
 *     fetched via `getconfig`.
 *
 * Allowlist is default-deny: an empty (or missing) `allowedSenderIds` rejects
 * every inbound message.
 */
export function createWechatChannel(opts: WechatChannelOptions): ChannelAdapter {
  const channelType = WECHAT_PROVIDER;
  const baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const splitAt = opts.splitAt && opts.splitAt > 0 ? opts.splitAt : DEFAULT_SPLIT_AT;
  const allowedSenderIds = new Set((opts.allowedSenderIds ?? []).map((s) => String(s)));
  const fetchImpl: FetchLike =
    opts.fetchImpl ?? ((globalThis.fetch as unknown) as FetchLike);
  const now: () => number = opts.now ?? (() => Date.now());

  let botToken: string | undefined = opts.botToken;
  let stateStore: GatewayStateStore | null = null;
  let stopCallback: (() => void) | null = null;
  let sweepTimer: NodeJS.Timeout | null = null;
  let started = false;
  // W11: captured during start() so send() can push lastSendAt to the
  // gateway-tracked snapshot, not just the local statusSnapshot.
  let liveSetStatus:
    | ((patch: Partial<ChannelStatusSnapshot>) => void)
    | null = null;

  const traceContexts = new Map<string, TraceContext>();
  /** typing_ticket cache keyed by ilink user id. */
  const typingTickets = new Map<string, string>();

  let statusSnapshot: ChannelStatusSnapshot = {
    channel: opts.id,
    accountId: opts.accountId,
    running: false,
    connected: false,
    reconnectAttempts: 0,
    lastError: null,
    provider: WECHAT_PROVIDER,
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
    const secret = loadGatewaySecret<WechatSecret>(opts.id, opts.secretFile);
    if (secret && typeof secret.botToken === "string" && secret.botToken.length > 0) {
      botToken = secret.botToken;
    }
    return botToken;
  }

  function pruneTraceContexts(): void {
    const cutoff = now() - TRACE_CONTEXT_TTL_MS;
    for (const [k, v] of traceContexts) {
      if (v.updatedAt < cutoff) traceContexts.delete(k);
    }
  }

  function rememberTrace(traceId: string, ctx: TraceContext): void {
    // W1: prune oldest entry by updatedAt when cap is reached.
    if (traceContexts.size >= TRACE_CONTEXT_MAX) {
      let oldestKey: string | undefined;
      let oldestAt = Infinity;
      for (const [k, v] of traceContexts) {
        if (v.updatedAt < oldestAt) {
          oldestAt = v.updatedAt;
          oldestKey = k;
        }
      }
      if (oldestKey !== undefined) traceContexts.delete(oldestKey);
    }
    traceContexts.set(traceId, ctx);
  }

  function lookupTrace(traceId: string | null | undefined): TraceContext | null {
    if (!traceId) return null;
    const hit = traceContexts.get(traceId);
    if (!hit) return null;
    if (now() - hit.updatedAt > TRACE_CONTEXT_TTL_MS) {
      traceContexts.delete(traceId);
      return null;
    }
    return hit;
  }

  async function callApi<T = WechatGenericResp>(
    path: string,
    body: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<T> {
    if (!botToken) throw new Error("wechat bot token not loaded");
    const url = `${baseUrl}/${path.replace(/^\/+/, "")}`;
    const payload = { ...body, base_info: { ...WECHAT_BASE_INFO } };
    // C2: enforce per-call timeout via AbortSignal.timeout — matches telegram.ts.
    const init = {
      method: "POST",
      headers: wechatHeaders(botToken),
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    };
    const resp = await fetchImpl(url, init);
    const raw = await resp.text();
    if (!raw) return {} as T;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return {} as T;
    }
  }

  function extractText(msg: WechatInboundMsg): string {
    const parts: string[] = [];
    for (const item of msg.item_list ?? []) {
      if (item?.type === 1) {
        const t = item.text_item?.text;
        if (typeof t === "string" && t.length > 0) parts.push(t);
      }
    }
    return parts.join("\n").trim();
  }

  function normalizeInbound(msg: WechatInboundMsg): GatewayInboundMessage | null {
    if (msg.message_type !== 1) return null;
    const fromUid = typeof msg.from_user_id === "string" ? msg.from_user_id : "";
    const contextToken = typeof msg.context_token === "string" ? msg.context_token : "";
    if (!fromUid || !contextToken) return null;
    const text = extractText(msg);
    if (!text) return null;
    if (!allowedSenderIds.has(fromUid)) return null;

    const sanitized = sanitizeUntrustedContent(text);
    const receivedAt = now();
    // W10: append randomUUID() to the fallback so two messages received in
    // the same millisecond can't collide. Trace id below already does this.
    const messageId =
      typeof msg.client_id === "string" && msg.client_id.length > 0
        ? msg.client_id
        : `wechat:${fromUid}:${receivedAt}:${randomUUID()}`;
    // Trace id MUST be unique per inbound so the per-trace context cache
    // does not collide when the same user sends two messages back-to-back.
    const traceId = `wechat:${fromUid}:${receivedAt}:${randomUUID()}`;

    rememberTrace(traceId, {
      contextToken,
      fromUserId: fromUid,
      updatedAt: receivedAt,
    });

    return {
      id: messageId,
      channel: opts.id,
      accountId: opts.accountId,
      conversation: {
        id: `wechat:user:${fromUid}`,
        kind: "direct",
      },
      sender: {
        id: fromUid,
        kind: "user",
      },
      text: sanitized,
      raw: msg,
      replyTo: null,
      mentioned: false,
      receivedAt,
      // streamable: false — iLink has no message-edit / native streaming.
      trace: { id: traceId, streamable: false },
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
      // W2: ensure stop() is a clean no-op even though pollLoop never armed
      // its inner stopCallback. The next `upsert_gateway` (which forwards
      // the freshly-confirmed bot token via secret-store) will rebuild the
      // channel — there is no in-process retry timer here on purpose.
      stopCallback = () => {};
      markStatus({
        running: false,
        connected: false,
        authorized: false,
        lastError: "missing_secret",
      });
      log.error("wechat missing bot token", { gatewayId: opts.id });
      return;
    }

    let updatesBuf: string = state.getCursor() ?? "";

    // W3: do NOT report `authorized: true` until the first getupdates call
    // returns ret === 0. Mark only the loop as starting so test_gateway and
    // the dashboard see the in-progress state instead of a false positive.
    markStatus({
      running: true,
      connected: false,
      authorized: false,
      reconnectAttempts: 0,
      lastError: null,
      lastStartAt: Date.now(),
    });
    log.info("wechat poll loop starting", {
      gatewayId: opts.id,
      hasCursor: updatesBuf.length > 0,
    });

    let stopped = false;
    const onAbort = () => {
      stopped = true;
    };
    abortSignal.addEventListener("abort", onAbort, { once: true });
    stopCallback = () => {
      stopped = true;
    };

    sweepTimer = setInterval(() => {
      try {
        pruneTraceContexts();
      } catch {
        // best-effort
      }
    }, TRACE_CONTEXT_SWEEP_MS);
    if (typeof sweepTimer.unref === "function") sweepTimer.unref();

    let firstPollOk = false;
    while (!stopped && !abortSignal.aborted) {
      try {
        const resp = await callApi<WechatGetUpdatesResp>(
          "ilink/bot/getupdates",
          { get_updates_buf: updatesBuf },
          (POLL_TIMEOUT_S + 10) * 1000,
        );
        markStatus({ lastPollAt: Date.now() });
        // W3: a successful response (`ret === 0`) is the only signal we
        // have that the bot token actually authenticates. Promote the
        // channel to authorized only on that boundary.
        if (!firstPollOk && resp.ret === 0) {
          firstPollOk = true;
          markStatus({ connected: true, authorized: true });
        }
        const msgs = Array.isArray(resp.msgs) ? resp.msgs : [];
        // W4: persist the cursor only AFTER all emits return cleanly. If
        // any emit throws, leave updatesBuf and the on-disk cursor alone
        // so the same batch retries on the next poll.
        const nextBuf =
          typeof resp.get_updates_buf === "string" ? resp.get_updates_buf : updatesBuf;
        if (msgs.length === 0) {
          if (nextBuf !== updatesBuf) {
            updatesBuf = nextBuf;
            state.update({ cursor: updatesBuf });
          }
          // Yield a macrotask so abort signals fire even when the test fetch
          // stub resolves synchronously (real iLink getupdates blocks ≤35s).
          await sleep(0, abortSignal);
          continue;
        }

        let emitFailed = false;
        for (const msg of msgs) {
          const normalized = normalizeInbound(msg);
          if (!normalized) continue;
          markStatus({ lastInboundAt: Date.now() });
          const envelope: GatewayInboundEnvelope = { message: normalized };
          try {
            await emit(envelope);
          } catch (err) {
            emitFailed = true;
            log.error("wechat emit threw — leaving cursor unchanged", {
              err: redactSecret(String(err), botToken),
            });
            break;
          }
        }
        if (!emitFailed && nextBuf !== updatesBuf) {
          updatesBuf = nextBuf;
          state.update({ cursor: updatesBuf });
        }
      } catch (err) {
        if (stopped || abortSignal.aborted) break;
        const name = (err as Error)?.name ?? "";
        if (name === "AbortError" || name === "TimeoutError") {
          log.warn("wechat poll transient", { name });
          await sleep(TRANSIENT_BACKOFF_MS, abortSignal);
          continue;
        }
        const errStr = redactSecret(String(err), botToken);
        log.error("wechat poll failed", { err: errStr });
        markStatus({ lastError: errStr });
        await sleep(POLL_BACKOFF_MS, abortSignal);
      }
    }

    if (sweepTimer) {
      clearInterval(sweepTimer);
      sweepTimer = null;
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

  async function getTypingTicket(userId: string, contextToken: string): Promise<string> {
    const cached = typingTickets.get(userId);
    if (cached) return cached;
    try {
      const resp = await callApi<{ ret?: number; typing_ticket?: string }>(
        "ilink/bot/getconfig",
        { ilink_user_id: userId, context_token: contextToken },
        10_000,
      );
      const ticket = typeof resp.typing_ticket === "string" ? resp.typing_ticket : "";
      if (ticket) typingTickets.set(userId, ticket);
      return ticket;
    } catch {
      return "";
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
      if (sweepTimer) {
        clearInterval(sweepTimer);
        sweepTimer = null;
      }
      try {
        stateStore?.flush();
      } catch (e) {
        // W7: log flush failures at stop — previously swallowed silently.
        // No ctx.log here; use console to avoid import cycle.
        console.warn("[wechat] state-flush-on-stop failed", String(e));
      }
    },

    async send(ctx: ChannelSendContext): Promise<ChannelSendResult> {
      const { message, log } = ctx;
      if (!loadTokenFromSecretIfNeeded()) {
        throw new Error("wechat bot token not loaded");
      }
      const trace = lookupTrace(message.traceId);
      if (!trace) {
        throw new Error(
          `wechat send: no context_token for traceId=${message.traceId ?? "<missing>"}` +
            ` (expired or never bound — daemon does not support unsolicited replies)`,
        );
      }

      const chunks = splitText(message.text, splitAt);
      let lastClientId: string | null = null;
      for (const chunk of chunks) {
        const clientId = `botcord-${randomUUID()}`;
        const body = {
          msg: {
            from_user_id: "",
            to_user_id: trace.fromUserId,
            client_id: clientId,
            message_type: 2, // BOT → user
            message_state: 2, // FINISH
            context_token: trace.contextToken,
            item_list: [{ type: 1, text_item: { text: chunk } }],
          },
        };
        const resp = await callApi<WechatGenericResp>("ilink/bot/sendmessage", body, 15_000);
        if (resp.ret !== 0 && resp.ret !== undefined) {
          log.warn("wechat sendmessage non-zero ret", { ret: resp.ret });
          throw new Error(redactSecret(`wechat sendmessage failed: ret=${resp.ret}`, botToken));
        }
        lastClientId = clientId;
      }
      const sendAt = Date.now();
      statusSnapshot = { ...statusSnapshot, lastSendAt: sendAt };
      // W11: push to the gateway snapshot too — the dashboard reads this.
      if (liveSetStatus) liveSetStatus({ lastSendAt: sendAt });
      return { providerMessageId: lastClientId };
    },

    async typing(ctx: ChannelTypingContext): Promise<void> {
      if (!loadTokenFromSecretIfNeeded()) return;
      const trace = lookupTrace(ctx.traceId);
      if (!trace) return;
      try {
        const ticket = await getTypingTicket(trace.fromUserId, trace.contextToken);
        if (!ticket) return;
        await callApi(
          "ilink/bot/sendtyping",
          {
            ilink_user_id: trace.fromUserId,
            typing_ticket: ticket,
            status: 1,
          },
          10_000,
        );
      } catch (err) {
        ctx.log.warn("wechat typing failed", { err: redactSecret(String(err), botToken) });
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
