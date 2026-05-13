import * as Lark from "@larksuiteoapi/node-sdk";
import { readFileSync } from "node:fs";
import path from "node:path";
import type {
  ChannelAdapter,
  ChannelSendContext,
  ChannelSendResult,
  ChannelStartContext,
  ChannelStatusSnapshot,
  ChannelStopContext,
  ChannelTypingContext,
  GatewayOutboundAttachment,
  GatewayInboundMessage,
} from "../types.js";
import { sanitizeUntrustedContent } from "./sanitize.js";
import { loadGatewaySecret } from "./secret-store.js";
import { GatewayStateStore } from "./state-store.js";
import { splitText } from "./text-split.js";
import type { FeishuDomain } from "./feishu-registration.js";

const FEISHU_PROVIDER = "feishu" as const;
const DEFAULT_SPLIT_AT = 4000;
const MAX_SEEN_MESSAGES = 2048;

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
  stateFile?: string;
  stateDebounceMs?: number;
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

interface FeishuProviderState {
  seenMessageIds?: Record<string, number>;
}

interface FeishuApiResponse {
  code?: number;
  msg?: string;
  data?: Record<string, unknown>;
  [key: string]: unknown;
}

type FeishuClient = { request(args: unknown): Promise<unknown> };

function sdkDomain(domain: FeishuDomain | undefined): unknown {
  const sdk = Lark as unknown as {
    Domain?: { Feishu?: unknown; Lark?: unknown };
  };
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

export function createFeishuChannel(opts: FeishuChannelOptions): ChannelAdapter {
  const splitAt = opts.splitAt && opts.splitAt > 0 ? opts.splitAt : DEFAULT_SPLIT_AT;
  const allowedSenderIds = new Set((opts.allowedSenderIds ?? []).map(String));
  const allowedChatIds = new Set((opts.allowedChatIds ?? []).map(String));
  let appSecret = opts.appSecret;
  let wsClient: { start(opts: unknown): unknown; close(opts?: unknown): unknown } | null = null;
  let client: FeishuClient | null = null;
  let stateStore: GatewayStateStore | null = null;
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

  function ensureState(): GatewayStateStore {
    if (!stateStore) {
      stateStore = new GatewayStateStore(opts.id, {
        override: opts.stateFile,
        debounceMs: opts.stateDebounceMs,
      });
    }
    return stateStore;
  }

  function readProviderState(): FeishuProviderState {
    return (ensureState().getProviderState() ?? {}) as FeishuProviderState;
  }

  function hasSeenMessage(messageId: string): boolean {
    const seen = readProviderState().seenMessageIds ?? {};
    return Object.prototype.hasOwnProperty.call(seen, messageId);
  }

  function rememberMessage(messageId: string): void {
    const providerState = readProviderState();
    const seen = { ...(providerState.seenMessageIds ?? {}), [messageId]: Date.now() };
    const entries = Object.entries(seen).sort((a, b) => a[1] - b[1]);
    while (entries.length > MAX_SEEN_MESSAGES) entries.shift();
    ensureState().update({
      providerState: {
        ...providerState,
        seenMessageIds: Object.fromEntries(entries),
      },
    });
  }

  function loadSecretIfNeeded(): string | undefined {
    if (appSecret) return appSecret;
    const secret = loadGatewaySecret<FeishuSecret>(opts.id, opts.secretFile);
    if (typeof secret?.appSecret === "string" && secret.appSecret.length > 0) {
      appSecret = secret.appSecret;
    }
    return appSecret;
  }

  function ensureClient(): FeishuClient {
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
    const chatId = message.chat_id;
    const messageId = message.message_id;
    const senderOpenId = sender.sender_id?.open_id;
    if (!chatId || !messageId || !senderOpenId) return null;
    if (botOpenId && senderOpenId === botOpenId) return null;
    if (hasSeenMessage(messageId)) return null;

    if (allowedChatIds.size > 0 && !allowedChatIds.has(chatId)) return null;
    if (!allowedSenderIds.has(senderOpenId)) return null;

    const text = parseInboundText(message);
    if (text === null) return null;
    rememberMessage(messageId);
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
      Promise.resolve(wsClient.start({ eventDispatcher: dispatcher })).catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        markStatus({
          running: false,
          connected: false,
          authorized: false,
          lastError: message,
          reconnectAttempts: (statusSnapshot.reconnectAttempts ?? 0) + 1,
        });
        ctx.log.warn("feishu ws client failed", { err: message });
      });
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
      try {
        stateStore?.flush();
      } catch (err) {
        ctx.log.warn("feishu state flush failed", {
          err: err instanceof Error ? err.message : String(err),
        });
      }
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

  async function callFeishu(args: unknown): Promise<FeishuApiResponse> {
    const res = (await ensureClient().request(args)) as FeishuApiResponse;
    if (res.code !== undefined && res.code !== 0) {
      throw new Error(res.msg || `feishu api failed: code=${res.code}`);
    }
    return res;
  }

  function resultMessageId(res: FeishuApiResponse): string | undefined {
    return (
      (typeof res.data?.message_id === "string" ? res.data.message_id : undefined) ??
      (typeof res.message_id === "string" ? res.message_id : undefined)
    );
  }

  function resultResourceKey(res: FeishuApiResponse, key: "image_key" | "file_key"): string {
    const direct = res[key];
    if (typeof direct === "string") return direct;
    const nested = res.data?.[key];
    if (typeof nested === "string") return nested;
    throw new Error(`feishu upload failed: ${key} missing`);
  }

  function attachmentBytes(attachment: GatewayOutboundAttachment): Buffer {
    if (attachment.data) return Buffer.from(attachment.data);
    if (attachment.filePath) return readFileSync(attachment.filePath);
    throw new Error("feishu attachment requires filePath or data");
  }

  function fileNameForAttachment(attachment: GatewayOutboundAttachment): string {
    if (attachment.filename) return attachment.filename;
    if (attachment.filePath) return path.basename(attachment.filePath);
    return "attachment";
  }

  function isImageAttachment(attachment: GatewayOutboundAttachment): boolean {
    if (attachment.kind === "image") return true;
    if (attachment.contentType?.startsWith("image/")) return true;
    return /\.(png|jpe?g|gif|webp|bmp|tiff?|ico)$/i.test(fileNameForAttachment(attachment));
  }

  function feishuFileType(attachment: GatewayOutboundAttachment): string {
    if (attachment.kind === "video") return "mp4";
    const name = fileNameForAttachment(attachment).toLowerCase();
    const contentType = attachment.contentType?.toLowerCase() ?? "";
    if (contentType.includes("pdf") || name.endsWith(".pdf")) return "pdf";
    if (contentType.includes("word") || /\.(doc|docx)$/i.test(name)) return "doc";
    if (contentType.includes("spreadsheet") || /\.(xls|xlsx)$/i.test(name)) return "xls";
    if (contentType.includes("presentation") || /\.(ppt|pptx)$/i.test(name)) return "ppt";
    if (contentType.includes("audio/ogg") || name.endsWith(".opus")) return "opus";
    if (contentType.includes("video/mp4") || name.endsWith(".mp4")) return "mp4";
    return "stream";
  }

  async function uploadAttachment(attachment: GatewayOutboundAttachment): Promise<{
    msgType: "image" | "file" | "audio" | "media";
    content: Record<string, unknown>;
  }> {
    const bytes = attachmentBytes(attachment);
    if (isImageAttachment(attachment)) {
      const res = await callFeishu({
        method: "POST",
        url: "/open-apis/im/v1/images",
        data: { image_type: "message", image: bytes },
        headers: { "Content-Type": "multipart/form-data" },
      });
      return { msgType: "image", content: { image_key: resultResourceKey(res, "image_key") } };
    }
    const fileType = feishuFileType(attachment);
    const res = await callFeishu({
      method: "POST",
      url: "/open-apis/im/v1/files",
      data: {
        file_type: fileType,
        file_name: fileNameForAttachment(attachment),
        file: bytes,
      },
      headers: { "Content-Type": "multipart/form-data" },
    });
    const fileKey = resultResourceKey(res, "file_key");
    if (fileType === "opus") return { msgType: "audio", content: { file_key: fileKey } };
    if (fileType === "mp4") return { msgType: "media", content: { file_key: fileKey } };
    return { msgType: "file", content: { file_key: fileKey } };
  }

  async function sendPayload(args: {
    chatId: string;
    msgType: string;
    content: Record<string, unknown>;
    replyTo?: string | null;
    replyInThread?: boolean;
  }): Promise<string | undefined> {
    const data: Record<string, unknown> = {
      msg_type: args.msgType,
      content: JSON.stringify(args.content),
    };
    if (args.replyTo) {
      data.reply_in_thread = args.replyInThread ?? false;
      const res = await callFeishu({
        method: "POST",
        url: `/open-apis/im/v1/messages/${encodeURIComponent(args.replyTo)}/reply`,
        data,
      });
      return resultMessageId(res);
    }
    const res = await callFeishu({
      method: "POST",
      url: "/open-apis/im/v1/messages",
      params: { receive_id_type: "chat_id" },
      data: {
        ...data,
        receive_id: args.chatId,
      },
    });
    return resultMessageId(res);
  }

  async function send(ctx: ChannelSendContext): Promise<ChannelSendResult> {
    const chatId = chatIdFromConversation(ctx.message.conversationId);
    if (!chatId) {
      throw new Error("unsupported feishu conversation id");
    }
    let providerMessageId: string | undefined;
    const replyTo = ctx.message.replyTo ?? ctx.message.threadId ?? null;
    const textParts = ctx.message.text.length > 0 ? splitText(ctx.message.text, splitAt) : [];
    for (const part of textParts) {
      providerMessageId = await sendPayload({
        chatId,
        msgType: "text",
        content: { text: part },
        replyTo,
        replyInThread: Boolean(ctx.message.threadId),
      }) ?? providerMessageId;
    }
    for (const attachment of ctx.message.attachments ?? []) {
      const uploaded = await uploadAttachment(attachment);
      providerMessageId = await sendPayload({
        chatId,
        msgType: uploaded.msgType,
        content: uploaded.content,
        replyTo,
        replyInThread: Boolean(ctx.message.threadId),
      }) ?? providerMessageId;
    }
    markStatus({ lastSendAt: Date.now() });
    return { providerMessageId };
  }

  async function typing(ctx: ChannelTypingContext): Promise<void> {
    ctx.log.debug("feishu typing ignored: no native bot typing API", {
      channel: opts.id,
      conversationId: ctx.conversationId,
    });
  }

  async function stop(_ctx: ChannelStopContext): Promise<void> {
    try {
      wsClient?.close({ force: true });
    } catch {
      // best effort
    }
    wsClient = null;
    try {
      stateStore?.close();
    } catch {
      // best effort
    }
    markStatus({ running: false, connected: false });
  }

  return {
    id: opts.id,
    type: FEISHU_PROVIDER,
    start,
    stop,
    send,
    typing,
    status: () => ({ ...statusSnapshot }),
  };
}
