import * as Lark from "@larksuiteoapi/node-sdk";
import type {
  ChannelAdapter,
  ChannelSendContext,
  ChannelSendResult,
  ChannelStartContext,
  ChannelStatusSnapshot,
  ChannelStopContext,
  GatewayInboundMessage,
} from "../types.js";
import { sanitizeUntrustedContent } from "./sanitize.js";
import { loadGatewaySecret } from "./secret-store.js";
import { splitText } from "./text-split.js";
import type { FeishuDomain } from "./feishu-registration.js";

const FEISHU_PROVIDER = "feishu" as const;
const DEFAULT_SPLIT_AT = 4000;

export interface FeishuChannelOptions {
  id: string;
  accountId: string;
  appId?: string;
  appSecret?: string;
  domain?: FeishuDomain;
  allowedSenderIds?: string[];
  allowedChatIds?: string[];
  splitAt?: number;
  secretFile?: string;
}

interface FeishuSecret {
  appSecret?: string;
  [key: string]: unknown;
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

function sdkDomain(domain: FeishuDomain | undefined): unknown {
  const sdk = Lark as unknown as {
    Domain?: { Feishu?: unknown; Lark?: unknown };
  };
  return domain === "lark" ? sdk.Domain?.Lark : sdk.Domain?.Feishu;
}

function parseTextContent(content: string | undefined): string | null {
  if (!content) return null;
  try {
    const parsed = JSON.parse(content) as { text?: unknown };
    return typeof parsed.text === "string" ? parsed.text : null;
  } catch {
    return content;
  }
}

function senderLabel(event: FeishuMessageEvent): string | undefined {
  const mentions = event.message?.mentions ?? [];
  const senderOpenId = event.sender?.sender_id?.open_id;
  const hit = mentions.find((m) => m.id?.open_id && m.id.open_id === senderOpenId);
  return typeof hit?.name === "string" && hit.name ? hit.name : undefined;
}

export function createFeishuChannel(opts: FeishuChannelOptions): ChannelAdapter {
  const splitAt = opts.splitAt && opts.splitAt > 0 ? opts.splitAt : DEFAULT_SPLIT_AT;
  const allowedSenderIds = new Set((opts.allowedSenderIds ?? []).map(String));
  const allowedChatIds = new Set((opts.allowedChatIds ?? []).map(String));
  let appSecret = opts.appSecret;
  let wsClient: { start(opts: unknown): unknown; close(opts?: unknown): unknown } | null = null;
  let client: { request(args: unknown): Promise<unknown> } | null = null;
  let botOpenId: string | undefined;
  let botName: string | undefined;
  let liveSetStatus: ((patch: Partial<ChannelStatusSnapshot>) => void) | null = null;

  let statusSnapshot: ChannelStatusSnapshot = {
    channel: opts.id,
    accountId: opts.accountId,
    running: false,
    connected: false,
    reconnectAttempts: 0,
    lastError: null,
    provider: FEISHU_PROVIDER,
    authorized: false,
  };

  function loadSecretIfNeeded(): string | undefined {
    if (appSecret) return appSecret;
    const secret = loadGatewaySecret<FeishuSecret>(opts.id, opts.secretFile);
    if (typeof secret?.appSecret === "string" && secret.appSecret.length > 0) {
      appSecret = secret.appSecret;
    }
    return appSecret;
  }

  function ensureClient(): { request(args: unknown): Promise<unknown> } {
    if (client) return client;
    if (!opts.appId || !loadSecretIfNeeded()) {
      throw new Error("feishu appId/appSecret not loaded");
    }
    const sdk = Lark as unknown as {
      Client: new (args: Record<string, unknown>) => { request(args: unknown): Promise<unknown> };
      AppType?: { SelfBuild?: unknown };
    };
    client = new sdk.Client({
      appId: opts.appId,
      appSecret,
      appType: sdk.AppType?.SelfBuild,
      domain: sdkDomain(opts.domain),
    });
    return client;
  }

  function markStatus(
    patch: Partial<ChannelStatusSnapshot>,
    setStatus?: (patch: Partial<ChannelStatusSnapshot>) => void,
  ): void {
    statusSnapshot = { ...statusSnapshot, ...patch };
    (setStatus ?? liveSetStatus)?.(patch);
  }

  async function probe(): Promise<void> {
    const res = (await ensureClient().request({
      method: "POST",
      url: "/open-apis/bot/v1/openclaw_bot/ping",
      data: { needBotInfo: true },
    })) as { code?: number; msg?: string; data?: { pingBotInfo?: { botID?: string; botName?: string } } };
    if (res.code !== 0) {
      throw new Error(res.msg || `feishu bot ping failed: code=${res.code}`);
    }
    botOpenId = res.data?.pingBotInfo?.botID;
    botName = res.data?.pingBotInfo?.botName;
  }

  function normalizeMessage(event: FeishuMessageEvent): GatewayInboundMessage | null {
    const message = event.message;
    const sender = event.sender;
    if (!message || !sender) return null;
    if (message.message_type !== "text") return null;
    const chatId = message.chat_id;
    const messageId = message.message_id;
    const senderOpenId = sender.sender_id?.open_id;
    if (!chatId || !messageId || !senderOpenId) return null;
    if (botOpenId && senderOpenId === botOpenId) return null;

    if (allowedChatIds.size > 0 && !allowedChatIds.has(chatId)) return null;
    if (!allowedSenderIds.has(senderOpenId)) return null;

    const text = parseTextContent(message.content);
    if (text === null) return null;
    const chatType = message.chat_type ?? "";
    const conversationKind: "direct" | "group" =
      chatType === "p2p" ? "direct" : "group";
    const conversationId =
      conversationKind === "direct" ? `feishu:user:${chatId}` : `feishu:chat:${chatId}`;
    const receivedAt = Number(message.create_time) || Date.now();

    return {
      id: `feishu:${messageId}`,
      channel: opts.id,
      accountId: opts.accountId,
      conversation: {
        id: conversationId,
        kind: conversationKind,
        threadId: message.root_id || message.parent_id || null,
      },
      sender: {
        id: `feishu:user:${senderOpenId}`,
        ...(senderLabel(event) ? { name: senderLabel(event) } : {}),
        kind: "user",
      },
      text: sanitizeUntrustedContent(text),
      raw: event,
      replyTo: messageId,
      mentioned: true,
      receivedAt,
      trace: { id: `feishu:${messageId}`, streamable: true },
    };
  }

  async function start(ctx: ChannelStartContext): Promise<void> {
    liveSetStatus = ctx.setStatus;
    try {
      if (!opts.appId || !loadSecretIfNeeded()) {
        markStatus({
          running: false,
          connected: false,
          authorized: false,
          lastError: "feishu appId/appSecret not loaded",
        }, ctx.setStatus);
        return;
      }
      await probe();
      const sdk = Lark as unknown as {
        EventDispatcher: new (args?: Record<string, unknown>) => {
          register(handlers: Record<string, (data: unknown) => unknown>): void;
        };
        WSClient: new (args: Record<string, unknown>) => {
          start(opts: unknown): unknown;
          close(opts?: unknown): unknown;
        };
        LoggerLevel?: { info?: unknown };
      };
      const dispatcher = new sdk.EventDispatcher({});
      dispatcher.register({
        "im.message.receive_v1": async (data: unknown) => {
          const normalized = normalizeMessage(data as FeishuMessageEvent);
          if (!normalized) return;
          markStatus({ lastInboundAt: Date.now(), connected: true, authorized: true });
          await ctx.emit({ message: normalized });
        },
      });
      wsClient = new sdk.WSClient({
        appId: opts.appId,
        appSecret,
        domain: sdkDomain(opts.domain),
        loggerLevel: sdk.LoggerLevel?.info,
      });
      markStatus({
        running: true,
        connected: true,
        authorized: true,
        lastError: null,
      }, ctx.setStatus);
      void wsClient.start({ eventDispatcher: dispatcher });
      await new Promise<void>((resolve) => {
        if (ctx.abortSignal.aborted) return resolve();
        ctx.abortSignal.addEventListener("abort", () => resolve(), { once: true });
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      markStatus({
        running: false,
        connected: false,
        authorized: false,
        lastError: message,
      }, ctx.setStatus);
      throw err;
    } finally {
      try {
        wsClient?.close({ force: true });
      } catch {
        // best effort
      }
      wsClient = null;
      markStatus({ running: false, connected: false }, ctx.setStatus);
    }
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

  async function send(ctx: ChannelSendContext): Promise<ChannelSendResult> {
    const chatId = chatIdFromConversation(ctx.message.conversationId);
    if (!chatId) {
        throw new Error("unsupported feishu conversation id");
    }
    const c = ensureClient();
    let providerMessageId: string | undefined;
    for (const part of splitText(ctx.message.text, splitAt)) {
      const res = (await c.request({
        method: "POST",
        url: "/open-apis/im/v1/messages",
        params: { receive_id_type: "chat_id" },
        data: {
          receive_id: chatId,
          msg_type: "text",
          content: JSON.stringify({ text: part }),
        },
      })) as { code?: number; msg?: string; data?: { message_id?: string } };
      if (res.code !== 0) {
        throw new Error(res.msg || `feishu send failed: code=${res.code}`);
      }
      providerMessageId = res.data?.message_id ?? providerMessageId;
    }
    markStatus({ lastSendAt: Date.now() });
    return { providerMessageId };
  }

  async function stop(_ctx: ChannelStopContext): Promise<void> {
    try {
      wsClient?.close({ force: true });
    } catch {
      // best effort
    }
    wsClient = null;
    markStatus({ running: false, connected: false });
  }

  return {
    id: opts.id,
    type: FEISHU_PROVIDER,
    start,
    stop,
    send,
    status: () => ({ ...statusSnapshot }),
  };
}
