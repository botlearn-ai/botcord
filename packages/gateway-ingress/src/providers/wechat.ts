import { randomBytes, randomUUID } from "node:crypto";

import { sanitizeUntrustedContent, splitText } from "@botcord/protocol-core";
import type { GatewayInboundMessage } from "@botcord/protocol-core";

import type { OutboundSendRequest, OutboundSendResult } from "../types.js";
import type {
  OutboundTypingRequest,
  ProviderAdapter,
  ProviderAdapterFactory,
  ProviderRuntimeContext,
} from "./types.js";

/**
 * WeChat (iLink Bot API) adapter for the cloud gateway ingress.
 *
 * Ported from `packages/daemon/src/gateway/channels/wechat.ts`. The
 * iLink server has no native streaming or message-edit; the adapter
 * long-polls `ilink/bot/getupdates` with `get_updates_buf` as the
 * cursor, and sends replies via `ilink/bot/sendmessage`.
 *
 * Architecture-level changes versus the daemon source:
 *
 *   - cursor: still persisted, but through `ctx.persistCursor` instead
 *     of the daemon file-backed state-store. Schema is `{ buf: string }`.
 *   - secret: resolved by the runner through `ctx.secret.botToken`.
 *   - dedupe: dropped from the adapter — orchestrator deduplicates by
 *     `providerEventId` derived from `client_id` (or a synthetic id
 *     when iLink omits it). `seenMessageIds` was never needed here
 *     anyway because the iLink cursor advances monotonically.
 *   - trace cache: kept, in-memory only. Maps `traceId → context_token`
 *     for outbound `sendmessage`. iLink does NOT accept unsolicited
 *     replies — outbound must reuse the inbound `context_token`, so
 *     this cache is load-bearing. TTL 30 min mirrors daemon doc.
 *   - typing (`sendtyping`): fired from `typing()` when the daemon emits
 *     a `gateway_outbound_typing` runtime frame. Per-user `typing_ticket`
 *     is fetched via `getconfig` and cached in-process keyed by ilink uid.
 *   - media upload (encrypted CDN flow, AES-128-ECB): omitted from
 *     MVP. iLink media is text-only-aware for now.
 *
 * Allowlist is default-allow when `allowedSenderIds` is empty (matches
 * Telegram). The daemon adapter defaulted to deny because BotCord room
 * permissions don't apply to third-party direct conversations — for
 * cloud Cloud Agent gateways the user owns the bot and the dashboard
 * gates who can bind it, so default-allow is the right ergonomic.
 */
const WECHAT_PROVIDER = "wechat" as const;
const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
const DEFAULT_SPLIT_AT = 1800;
/** iLink server holds getupdates ≤35 s; allow slack on the client side. */
const POLL_TIMEOUT_S = 60;
const POLL_BACKOFF_MS = 3000;
const TRANSIENT_BACKOFF_MS = 1000;
const TRACE_CONTEXT_TTL_MS = 30 * 60 * 1000;
const TRACE_CONTEXT_SWEEP_MS = 5 * 60 * 1000;
const TRACE_CONTEXT_MAX = 5000;
const WECHAT_CHANNEL_VERSION = "1.0.2";
const WECHAT_BASE_INFO = { channel_version: WECHAT_CHANNEL_VERSION } as const;

interface WechatSecret {
  botToken?: string;
}

interface WechatConnectionConfig {
  baseUrl?: string;
  allowedSenderIds?: string[];
  splitAt?: number;
  traceContextMax?: number;
}

interface WechatTextItem {
  type?: number;
  text_item?: { text?: string };
  [k: string]: unknown;
}

interface WechatInboundMsg {
  message_type?: number;
  from_user_id?: string;
  context_token?: string;
  client_id?: unknown;
  item_list?: WechatTextItem[];
  [k: string]: unknown;
}

interface WechatGetUpdatesResp {
  ret?: number;
  get_updates_buf?: string;
  msgs?: WechatInboundMsg[];
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

/** `X-WECHAT-UIN: base64(str(random uint32))` — fresh per request, anti-replay. */
function wechatUinHeader(): string {
  const n = randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(n), "utf8").toString("base64");
}

function wechatHeaders(botToken: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "X-WECHAT-UIN": wechatUinHeader(),
    Authorization: `Bearer ${botToken}`,
  };
}

function redactToken(input: string, token: string | undefined): string {
  if (!token || !input) return input;
  return input.split(token).join("[REDACTED]");
}

export interface WechatProviderOptions {
  gatewayId: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export function createWechatProvider(opts: WechatProviderOptions): ProviderAdapter {
  const fetchImpl: typeof fetch = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const now: () => number = opts.now ?? (() => Date.now());

  let activeCtx: ProviderRuntimeContext | null = null;
  let botToken: string | undefined;
  let baseUrl = DEFAULT_BASE_URL;
  let splitAt = DEFAULT_SPLIT_AT;
  let allowedSenderIds = new Set<string>();
  let traceContextMax = TRACE_CONTEXT_MAX;
  let stopController: AbortController | null = null;
  let sweepTimer: ReturnType<typeof setInterval> | null = null;
  const traceContexts = new Map<string, TraceContext>();
  /** Per-ilink-user typing_ticket cache. iLink returns the same ticket for
   * the lifetime of a context_token, so caching avoids an extra round-trip
   * before every typing ping. */
  const typingTickets = new Map<string, string>();

  function pruneTraceContexts(): void {
    const cutoff = now() - TRACE_CONTEXT_TTL_MS;
    for (const [k, v] of traceContexts) {
      if (v.updatedAt < cutoff) traceContexts.delete(k);
    }
  }

  function rememberTrace(traceId: string, ctx: TraceContext): void {
    if (traceContexts.size >= traceContextMax) {
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

  function lookupTraceByConversation(conversationId: string): TraceContext | null {
    if (!conversationId.startsWith("wechat:user:")) return null;
    const fromUid = conversationId.slice("wechat:user:".length);
    pruneTraceContexts();
    let best: TraceContext | null = null;
    for (const v of traceContexts.values()) {
      if (v.fromUserId !== fromUid) continue;
      if (!best || v.updatedAt > best.updatedAt) best = v;
    }
    return best;
  }

  async function callApi<T = WechatGenericResp>(
    path: string,
    body: Record<string, unknown>,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<T> {
    if (!botToken) throw new Error("wechat bot token not loaded");
    const url = `${baseUrl}/${path.replace(/^\/+/, "")}`;
    const payload = { ...body, base_info: { ...WECHAT_BASE_INFO } };
    const lease = createTimeoutSignal(timeoutMs, signal);
    let resp: Response;
    try {
      resp = await fetchImpl(url, {
        method: "POST",
        headers: wechatHeaders(botToken),
        body: JSON.stringify(payload),
        signal: lease.signal,
      });
    } finally {
      lease.cleanup();
    }
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

  function normalizeInbound(
    msg: WechatInboundMsg,
    accountId: string,
    channelId: string,
  ): { message: GatewayInboundMessage; providerEventId: string } | null {
    if (msg.message_type !== 1) return null;
    const fromUid = typeof msg.from_user_id === "string" ? msg.from_user_id : "";
    const contextToken = typeof msg.context_token === "string" ? msg.context_token : "";
    if (!fromUid || !contextToken) return null;
    const text = extractText(msg);
    if (!text) return null;
    if (allowedSenderIds.size > 0 && !allowedSenderIds.has(fromUid)) return null;

    const sanitized = sanitizeUntrustedContent(text);
    const receivedAt = now();
    const clientId =
      typeof msg.client_id === "string" && msg.client_id.length > 0
        ? msg.client_id
        : `wechat:${fromUid}:${receivedAt}:${randomUUID()}`;
    const traceId = `wechat:${fromUid}:${receivedAt}:${randomUUID()}`;

    rememberTrace(traceId, {
      contextToken,
      fromUserId: fromUid,
      updatedAt: receivedAt,
    });

    const normalized: GatewayInboundMessage = {
      id: clientId,
      channel: channelId,
      accountId,
      conversation: { id: `wechat:user:${fromUid}`, kind: "direct" },
      sender: { id: `wechat:user:${fromUid}`, kind: "user" },
      text: sanitized,
      replyTo: null,
      mentioned: false,
      receivedAt,
      trace: { id: traceId, streamable: false },
    };
    return { message: normalized, providerEventId: `wechat:${channelId}:${clientId}` };
  }

  async function loop(ctx: ProviderRuntimeContext): Promise<void> {
    activeCtx = ctx;
    const secret = ctx.secret as WechatSecret;
    botToken = secret.botToken;
    const config = ctx.connection.config as WechatConnectionConfig;
    if (config.baseUrl) baseUrl = config.baseUrl.replace(/\/+$/, "");
    if (config.splitAt && config.splitAt > 0) splitAt = config.splitAt;
    if (config.traceContextMax && config.traceContextMax > 0) {
      traceContextMax = config.traceContextMax;
    }
    allowedSenderIds = new Set((config.allowedSenderIds ?? []).map(String));

    if (!botToken) {
      ctx.markActivity({ lastError: "missing_secret" });
      ctx.log.error("wechat missing bot token", { gatewayId: ctx.connection.id });
      return;
    }

    stopController = new AbortController();
    const abortAggregate = new AbortController();
    if (ctx.abortSignal.aborted) abortAggregate.abort();
    else ctx.abortSignal.addEventListener("abort", () => abortAggregate.abort(), { once: true });
    stopController.signal.addEventListener("abort", () => abortAggregate.abort(), { once: true });

    sweepTimer = setInterval(() => {
      try {
        pruneTraceContexts();
      } catch {
        // best-effort
      }
    }, TRACE_CONTEXT_SWEEP_MS);
    if (typeof sweepTimer.unref === "function") sweepTimer.unref();

    let updatesBuf = String((ctx.loadCursor() as { buf?: string }).buf ?? "");

    while (!abortAggregate.signal.aborted) {
      try {
        const resp = await callApi<WechatGetUpdatesResp>(
          "ilink/bot/getupdates",
          { get_updates_buf: updatesBuf },
          (POLL_TIMEOUT_S + 10) * 1000,
          abortAggregate.signal,
        );
        ctx.markActivity({ lastPollAt: Date.now() });
        const msgs = Array.isArray(resp.msgs) ? resp.msgs : [];
        const nextBuf =
          typeof resp.get_updates_buf === "string" ? resp.get_updates_buf : updatesBuf;

        if (msgs.length === 0) {
          if (nextBuf !== updatesBuf) {
            updatesBuf = nextBuf;
            ctx.persistCursor({ buf: updatesBuf });
          }
          await sleep(0, abortAggregate.signal);
          continue;
        }

        let emitFailed = false;
        for (const msg of msgs) {
          const normalized = normalizeInbound(msg, ctx.connection.agentId, ctx.connection.id);
          if (!normalized) continue;
          ctx.markActivity({ lastInboundAt: Date.now() });
          try {
            await ctx.emit(normalized.message, normalized.providerEventId);
          } catch (err) {
            emitFailed = true;
            ctx.log.error("wechat emit threw — leaving cursor unchanged", {
              err: redactToken(String(err), botToken),
            });
            break;
          }
        }
        if (!emitFailed && nextBuf !== updatesBuf) {
          updatesBuf = nextBuf;
          ctx.persistCursor({ buf: updatesBuf });
        }
      } catch (err) {
        if (abortAggregate.signal.aborted) break;
        const name = (err as Error)?.name ?? "";
        if (name === "AbortError" || name === "TimeoutError") {
          await sleep(TRANSIENT_BACKOFF_MS, abortAggregate.signal);
          continue;
        }
        const errStr = redactToken(String(err), botToken);
        ctx.log.error("wechat poll failed", { err: errStr });
        ctx.markActivity({ lastError: errStr });
        await sleep(POLL_BACKOFF_MS, abortAggregate.signal);
      }
    }

    if (sweepTimer) {
      clearInterval(sweepTimer);
      sweepTimer = null;
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

  async function typing(request: OutboundTypingRequest): Promise<void> {
    // Best-effort: a stale trace, missing token, or iLink hiccup must not
    // break the turn. Errors are logged at debug level inside the adapter.
    if (!botToken) return;
    if (request.phase !== "started") return;
    const trace =
      lookupTrace(request.traceId ?? undefined) ??
      lookupTraceByConversation(request.conversationId);
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
      activeCtx?.log.debug("wechat typing failed", {
        err: redactToken(String(err), botToken),
      });
    }
  }

  async function send(request: OutboundSendRequest): Promise<OutboundSendResult> {
    if (!botToken) throw new Error("wechat bot token not loaded");
    // OutboundSendRequest carries no traceId today, so fall back to a
    // best-effort lookup by conversation. iLink rejects sends without a
    // matching context_token — if no trace is cached this throws and the
    // orchestrator surfaces the failure.
    const trace = lookupTraceByConversation(request.conversationId);
    if (!trace) {
      throw new Error(
        `wechat send: no context_token for conversation ${request.conversationId} ` +
          `(expired or never bound — iLink does not support unsolicited replies)`,
      );
    }
    const chunks = request.text.length > 0 ? splitText(request.text, splitAt) : [];
    let lastClientId: string | null = null;
    for (const chunk of chunks) {
      const clientId = `botcord-${randomUUID()}`;
      const body = {
        msg: {
          from_user_id: "",
          to_user_id: trace.fromUserId,
          client_id: clientId,
          message_type: 2,
          message_state: 2,
          context_token: trace.contextToken,
          item_list: [{ type: 1, text_item: { text: chunk } }],
        },
      };
      const resp = await callApi<WechatGenericResp>(
        "ilink/bot/sendmessage",
        body,
        15_000,
      );
      if (resp.ret !== 0 && resp.ret !== undefined) {
        throw new Error(
          redactToken(`wechat sendmessage failed: ret=${resp.ret}`, botToken),
        );
      }
      lastClientId = `wechat:${trace.fromUserId}:${clientId}`;
    }
    if (activeCtx) activeCtx.markActivity({ lastInboundAt: undefined });
    return { providerMessageId: lastClientId };
  }

  return {
    gatewayId: opts.gatewayId,
    provider: WECHAT_PROVIDER,
    async start(ctx) {
      await loop(ctx);
    },
    async stop(_reason) {
      stopController?.abort();
    },
    send,
    typing,
  };
}

export const wechatProviderFactory: ProviderAdapterFactory = (gatewayId) =>
  createWechatProvider({ gatewayId });

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

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
  const timer = setTimeout(
    () => abort(new DOMException("Timeout", "TimeoutError")),
    timeoutMs,
  );
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
