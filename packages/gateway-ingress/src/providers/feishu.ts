import * as Lark from "@larksuiteoapi/node-sdk";

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
 * Feishu / Lark event-WS adapter for the cloud gateway ingress.
 *
 * Ported from `packages/daemon/src/gateway/channels/feishu.ts` to the
 * ingress `ProviderAdapter` contract. Architecture-level changes versus
 * the daemon source:
 *
 *   - cursor/dedupe: dropped. The orchestrator deduplicates via
 *     `providerEventId` (= `feishu:${message_id}`) and durably writes
 *     accepted events. Adapters stay stateless.
 *   - secret store: dropped. `appSecret` is resolved by the runner
 *     through `ctx.secret`. The Hub never sees the secret.
 *   - state-store file: dropped. `seenMessageIds` lived only to guard
 *     against re-delivery on daemon restart; the orchestrator now owns
 *     that invariant.

 *   - typing reaction (im.v1 reactions API): fired from `typing()` when
 *     the daemon emits a `gateway_outbound_typing` runtime frame. Uses
 *     the inbound message id (extracted from the trace id) to attach a
 *     "Typing" emoji reaction; the reaction is removed when `send()`
 *     posts the reply for the matching turn.
 *   - attachment uploads: omitted from MVP. The runtime frame contract
 *     carries text only; richer outbound shapes land alongside
 *     streaming (`gateway_outbound_delta`).
 *
 * Inbound semantics (kept identical):
 *
 *   - subscribe to `im.message.receive_v1` over the lark WS client;
 *   - skip own-bot echoes when `botOpenId` is known (probe on start);
 *   - allowlist by chat id and/or sender open id (default-allow when
 *     unset, matching the ingress Telegram adapter);
 *   - extract text content; non-text message types surface as a short
 *     `[type message]` summary so the runtime still sees something;
 *   - normalize into `GatewayInboundMessage` with conversation id
 *     `feishu:user:{chatId}` (p2p) or `feishu:chat:{chatId}` (group).
 *
 * Outbound semantics:
 *
 *   - resolve chat id from `conversationId` prefix;
 *   - split text on the canonical 4000-char Feishu limit;
 *   - send via `/open-apis/im/v1/messages` (no reply chain — the
 *     OutboundSendRequest contract has no replyTo today).
 */
const FEISHU_PROVIDER = "feishu" as const;
const DEFAULT_SPLIT_AT = 4000;
const TYPING_EMOJI = "Typing" as const;

export type FeishuDomain = "feishu" | "lark";

interface FeishuSecret {
  appId?: string;
  appSecret?: string;
  domain?: FeishuDomain;
}

interface FeishuConnectionConfig {
  appId?: string;
  domain?: FeishuDomain;
  allowedSenderIds?: string[];
  allowedChatIds?: string[];
  splitAt?: number;
}

interface FeishuEventSender {
  sender_id?: {
    open_id?: string;
    user_id?: string;
    union_id?: string;
  };
  sender_type?: string;
  tenant_key?: string;
}

interface FeishuEventMessage {
  message_id?: string;
  root_id?: string;
  parent_id?: string;
  create_time?: string;
  chat_id?: string;
  chat_type?: string;
  message_type?: string;
  content?: string;
  mentions?: Array<{ id?: { open_id?: string; user_id?: string }; name?: string }>;
}

interface FeishuMessageEvent {
  sender?: FeishuEventSender;
  message?: FeishuEventMessage;
}

interface FeishuApiResponse {
  code?: number;
  msg?: string;
  data?: Record<string, unknown>;
  [key: string]: unknown;
}

type FeishuClient = { request(args: unknown): Promise<unknown> };

function sdkDomain(domain: FeishuDomain | undefined): unknown {
  const sdk = Lark as unknown as { Domain?: { Feishu?: unknown; Lark?: unknown } };
  return domain === "lark" ? sdk.Domain?.Lark : sdk.Domain?.Feishu;
}

function parseMessageContent(content: string | undefined): Record<string, unknown> | null {
  if (!content) return null;
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return { text: content };
  }
}

function parseInboundText(message: FeishuEventMessage): string | null {
  const parsed = parseMessageContent(message.content);
  if (!parsed) return null;
  if (typeof parsed.text === "string") return parsed.text;
  if (message.message_type === "image" && typeof parsed.image_key === "string") {
    return `[image: ${parsed.image_key}]`;
  }
  if (message.message_type === "file" && typeof parsed.file_key === "string") {
    const name = typeof parsed.file_name === "string" ? ` ${parsed.file_name}` : "";
    return `[file${name}: ${parsed.file_key}]`;
  }
  if (message.message_type === "audio" && typeof parsed.file_key === "string") {
    return `[audio: ${parsed.file_key}]`;
  }
  if (message.message_type === "media" && typeof parsed.file_key === "string") {
    return `[video: ${parsed.file_key}]`;
  }
  if (message.message_type) return `[${message.message_type} message]`;
  return null;
}

function senderLabel(event: FeishuMessageEvent): string | undefined {
  const mentions = event.message?.mentions ?? [];
  const senderOpenId = event.sender?.sender_id?.open_id;
  const hit = mentions.find((m) => m.id?.open_id && m.id.open_id === senderOpenId);
  return typeof hit?.name === "string" && hit.name ? hit.name : undefined;
}

function chatIdFromConversation(conversationId: string): string | null {
  if (conversationId.startsWith("feishu:user:")) {
    return conversationId.slice("feishu:user:".length);
  }
  if (conversationId.startsWith("feishu:chat:")) {
    return conversationId.slice("feishu:chat:".length);
  }
  return null;
}

export interface FeishuProviderOptions {
  gatewayId: string;
  /** Test hook: bypass the lark SDK entirely. */
  sdkOverride?: {
    createClient(args: Record<string, unknown>): FeishuClient;
    createWsClient(args: Record<string, unknown>): {
      start(opts: unknown): unknown;
      close(opts?: unknown): unknown;
    };
    createDispatcher(): {
      register(handlers: Record<string, (data: unknown) => unknown>): void;
    };
  };
}

export function createFeishuProvider(opts: FeishuProviderOptions): ProviderAdapter {
  const sdkOverride = opts.sdkOverride;

  let wsClient: { start(opts: unknown): unknown; close(opts?: unknown): unknown } | null = null;
  let client: FeishuClient | null = null;
  let activeCtx: ProviderRuntimeContext | null = null;
  let botOpenId: string | undefined;

  let appId: string | undefined;
  let appSecret: string | undefined;
  let domain: FeishuDomain | undefined;
  let splitAt = DEFAULT_SPLIT_AT;
  let allowedSenderIds = new Set<string>();
  let allowedChatIds = new Set<string>();
  /**
   * Active Typing reactions, keyed by turnId so `send()` for the same turn
   * can clean up the reaction once the visible reply lands. Second map is
   * a parallel index by messageId for cleanup on `stop()`.
   */
  const typingReactionsByTurn = new Map<string, { messageId: string; reactionId: string }>();

  function ensureClient(): FeishuClient {
    if (client) return client;
    if (!appId || !appSecret) throw new Error("feishu appId/appSecret not loaded");
    if (sdkOverride) {
      client = sdkOverride.createClient({
        appId,
        appSecret,
        domain: sdkDomain(domain),
      });
      return client;
    }
    const sdk = Lark as unknown as {
      Client: new (args: Record<string, unknown>) => FeishuClient;
      AppType?: { SelfBuild?: unknown };
    };
    client = new sdk.Client({
      appId,
      appSecret,
      appType: sdk.AppType?.SelfBuild,
      domain: sdkDomain(domain),
    });
    return client;
  }

  async function callFeishu(args: unknown): Promise<FeishuApiResponse> {
    const res = (await ensureClient().request(args)) as FeishuApiResponse;
    if (res.code !== undefined && res.code !== 0) {
      throw new Error(res.msg || `feishu api failed: code=${res.code}`);
    }
    return res;
  }

  async function probe(): Promise<void> {
    const res = (await callFeishu({
      method: "POST",
      url: "/open-apis/bot/v1/openclaw_bot/ping",
      data: { needBotInfo: true },
    })) as { data?: { pingBotInfo?: { botID?: string } } };
    botOpenId = res.data?.pingBotInfo?.botID;
  }

  function normalizeMessage(
    event: FeishuMessageEvent,
    accountId: string,
    channelId: string,
  ): { message: GatewayInboundMessage; providerEventId: string } | null {
    const message = event.message;
    const sender = event.sender;
    if (!message || !sender) return null;
    const chatId = message.chat_id;
    const messageId = message.message_id;
    const senderOpenId = sender.sender_id?.open_id;
    if (!chatId || !messageId || !senderOpenId) return null;
    if (botOpenId && senderOpenId === botOpenId) return null;

    if (allowedChatIds.size > 0 && !allowedChatIds.has(chatId)) return null;
    if (allowedSenderIds.size > 0 && !allowedSenderIds.has(senderOpenId)) return null;

    const text = parseInboundText(message);
    if (text === null) return null;
    const chatType = message.chat_type ?? "";
    const conversationKind: "direct" | "group" = chatType === "p2p" ? "direct" : "group";
    const conversationId =
      conversationKind === "direct" ? `feishu:user:${chatId}` : `feishu:chat:${chatId}`;
    const receivedAt = Number(message.create_time) || Date.now();
    const name = senderLabel(event);

    const normalized: GatewayInboundMessage = {
      id: `feishu:${messageId}`,
      channel: channelId,
      accountId,
      conversation: {
        id: conversationId,
        kind: conversationKind,
        threadId: message.root_id || message.parent_id || null,
      },
      sender: {
        id: `feishu:user:${senderOpenId}`,
        ...(name ? { name } : {}),
        kind: "user",
      },
      text: sanitizeUntrustedContent(text),
      replyTo: messageId,
      mentioned: true,
      receivedAt,
      trace: { id: `feishu:${messageId}`, streamable: true },
    };
    return { message: normalized, providerEventId: `feishu:${messageId}` };
  }

  async function start(ctx: ProviderRuntimeContext): Promise<void> {
    activeCtx = ctx;
    const secret = ctx.secret as FeishuSecret;
    const config = ctx.connection.config as FeishuConnectionConfig;
    appId = config.appId ?? secret.appId;
    appSecret = secret.appSecret;
    domain = config.domain ?? secret.domain;
    if (config.splitAt && config.splitAt > 0) splitAt = config.splitAt;
    allowedSenderIds = new Set((config.allowedSenderIds ?? []).map(String));
    allowedChatIds = new Set((config.allowedChatIds ?? []).map(String));

    if (!appId || !appSecret) {
      ctx.markActivity({ lastError: "missing_credential" });
      ctx.log.error("feishu missing appId/appSecret", { gatewayId: ctx.connection.id });
      return;
    }

    try {
      await probe();
    } catch (err) {
      ctx.markActivity({ lastError: redact(err) });
      ctx.log.warn("feishu probe failed, continuing without botOpenId", { err: redact(err) });
    }

    const dispatcher = sdkOverride
      ? sdkOverride.createDispatcher()
      : new (Lark as unknown as {
          EventDispatcher: new (args?: Record<string, unknown>) => {
            register(handlers: Record<string, (data: unknown) => unknown>): void;
          };
        }).EventDispatcher({});

    dispatcher.register({
      "im.message.receive_v1": async (data: unknown) => {
        const normalized = normalizeMessage(
          data as FeishuMessageEvent,
          ctx.connection.agentId,
          ctx.connection.id,
        );
        if (!normalized) return;
        ctx.markActivity({ lastInboundAt: Date.now() });
        try {
          await ctx.emit(normalized.message, normalized.providerEventId);
        } catch (err) {
          ctx.log.error("feishu emit threw", { err: redact(err) });
        }
      },
    });

    wsClient = sdkOverride
      ? sdkOverride.createWsClient({ appId, appSecret, domain: sdkDomain(domain) })
      : new (Lark as unknown as {
          WSClient: new (args: Record<string, unknown>) => {
            start(opts: unknown): unknown;
            close(opts?: unknown): unknown;
          };
          LoggerLevel?: { info?: unknown };
        }).WSClient({
          appId,
          appSecret,
          domain: sdkDomain(domain),
          loggerLevel: (Lark as unknown as { LoggerLevel?: { info?: unknown } }).LoggerLevel?.info,
        });

    ctx.markActivity({ lastPollAt: Date.now(), lastError: null });
    Promise.resolve(wsClient.start({ eventDispatcher: dispatcher })).catch((err) => {
      ctx.markActivity({ lastError: redact(err) });
      ctx.log.warn("feishu ws client failed", { err: redact(err) });
    });

    await new Promise<void>((resolve) => {
      if (ctx.abortSignal.aborted) return resolve();
      ctx.abortSignal.addEventListener("abort", () => resolve(), { once: true });
    });

    try {
      wsClient?.close({ force: true });
    } catch {
      // best effort
    }
    wsClient = null;
  }

  async function send(request: OutboundSendRequest): Promise<OutboundSendResult> {
    const chatId = chatIdFromConversation(request.conversationId);
    if (!chatId) {
      throw new Error(`feishu send: unrecognized conversationId "${request.conversationId}"`);
    }
    const chunks = request.text.length > 0 ? splitText(request.text, splitAt) : [];
    let lastMessageId: string | null = null;
    for (const chunk of chunks) {
      const res = await callFeishu({
        method: "POST",
        url: "/open-apis/im/v1/messages",
        params: { receive_id_type: "chat_id" },
        data: {
          receive_id: chatId,
          msg_type: "text",
          content: JSON.stringify({ text: chunk }),
        },
      });
      const id = resultMessageId(res);
      if (id) lastMessageId = `feishu:${id}`;
    }
    if (activeCtx) activeCtx.markActivity({ lastInboundAt: undefined });
    // Drop the Typing reaction for this turn now that the visible reply
    // has landed. Best-effort — if the cleanup call fails, the reaction
    // is left dangling but the user has already seen the reply.
    if (request.turnId) void removeTypingForTurn(request.turnId);
    return { providerMessageId: lastMessageId };
  }

  async function typing(request: OutboundTypingRequest): Promise<void> {
    if (!appId || !appSecret) return;
    if (request.phase !== "started") return;
    const messageId = messageIdFromTrace(request.traceId);
    if (!messageId) return;
    // Idempotent — repeated typing pings on the same turn keep the
    // single existing reaction.
    if (typingReactionsByTurn.has(request.turnId)) return;
    try {
      const res = await callFeishu({
        method: "POST",
        url: `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reactions`,
        data: { reaction_type: { emoji_type: TYPING_EMOJI } },
      });
      const reactionId = resultReactionId(res);
      if (reactionId) {
        typingReactionsByTurn.set(request.turnId, { messageId, reactionId });
      }
    } catch (err) {
      activeCtx?.log.debug("feishu typing reaction failed", { err: redact(err) });
    }
  }

  async function removeTypingForTurn(turnId: string): Promise<void> {
    const entry = typingReactionsByTurn.get(turnId);
    if (!entry) return;
    typingReactionsByTurn.delete(turnId);
    try {
      await callFeishu({
        method: "DELETE",
        url: `/open-apis/im/v1/messages/${encodeURIComponent(entry.messageId)}/reactions/${encodeURIComponent(entry.reactionId)}`,
      });
    } catch (err) {
      activeCtx?.log.debug("feishu typing reaction cleanup failed", { err: redact(err) });
    }
  }

  return {
    gatewayId: opts.gatewayId,
    provider: FEISHU_PROVIDER,
    start,
    async stop(_reason) {
      try {
        wsClient?.close({ force: true });
      } catch {
        // best effort
      }
      wsClient = null;
      const pending = Array.from(typingReactionsByTurn.keys());
      typingReactionsByTurn.clear();
      await Promise.allSettled(pending.map(removeTypingForTurn));
    },
    send,
    typing,
  };
}

function resultReactionId(res: FeishuApiResponse): string | undefined {
  const data = res.data;
  if (data && typeof data === "object" && typeof (data as Record<string, unknown>).reaction_id === "string") {
    return (data as Record<string, string>).reaction_id;
  }
  if (typeof (res as Record<string, unknown>).reaction_id === "string") {
    return (res as Record<string, string>).reaction_id;
  }
  return undefined;
}

function messageIdFromTrace(traceId: string | null | undefined): string | null {
  if (!traceId || !traceId.startsWith("feishu:")) return null;
  const rest = traceId.slice("feishu:".length);
  return rest.length > 0 ? rest : null;
}

function resultMessageId(res: FeishuApiResponse): string | undefined {
  return (
    (typeof res.data?.message_id === "string" ? res.data.message_id : undefined) ??
    (typeof res.message_id === "string" ? res.message_id : undefined)
  );
}

function redact(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export const feishuProviderFactory: ProviderAdapterFactory = (gatewayId) =>
  createFeishuProvider({ gatewayId });
