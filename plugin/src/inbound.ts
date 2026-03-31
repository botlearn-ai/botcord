/**
 * Inbound message dispatch — shared by websocket and polling paths.
 * Converts BotCord messages to OpenClaw inbound format.
 */
import { getBotCordRuntime } from "./runtime.js";
import { resolveAccountConfig } from "./config.js";
import { attachTokenPersistence } from "./credentials.js";
import { buildSessionKey } from "./session-key.js";
import { registerSessionRoom } from "./room-context.js";
import { readFileSync } from "node:fs";

// Simplified inline replacement for loadSessionStore from openclaw/plugin-sdk/mattermost.
// Avoids missing dist artifacts in npm-installed openclaw (see openclaw#53685).
function loadSessionStore(storePath: string): Record<string, any> {
  try {
    const raw = readFileSync(storePath, "utf-8");
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
import { sanitizeUntrustedContent, sanitizeSenderName } from "./sanitize.js";
import { BotCordClient } from "./client.js";
import { createBotCordReplyDispatcher } from "./reply-dispatcher.js";
import type { InboxMessage, MessageType } from "./types.js";

/** Normalize notifySession (string | string[] | undefined) to a flat array. */
export function normalizeNotifySessions(ns?: string | string[]): string[] {
  if (!ns) return [];
  return Array.isArray(ns) ? ns : [ns];
}

// Envelope types that count as notifications rather than normal messages
const NOTIFICATION_TYPES: ReadonlySet<string> = new Set([
  "contact_request",
  "contact_request_response",
  "contact_removed",
  "system",
]);

/**
 * Build a structured header line for inbound messages, e.g.:
 *   [BotCord Message] from: Link (ag_xxx) | to: ag_yyy | room: My Room
 */
function buildInboundHeader(params: {
  type: MessageType;
  senderName: string;
  accountId: string;
  chatType: "direct" | "group";
  roomName?: string;
}): string {
  const tag = NOTIFICATION_TYPES.has(params.type)
    ? "[BotCord Notification]"
    : "[BotCord Message]";

  const parts = [
    tag,
    `from: ${params.senderName}`,
    `to: ${params.accountId}`,
  ];

  if (params.chatType === "group" && params.roomName) {
    parts.push(`room: ${params.roomName}`);
  }

  return parts.join(" | ");
}

function appendRoomRule(content: string, roomRule?: string | null): string {
  const normalizedRule = roomRule?.trim();
  if (!normalizedRule) return content;
  const sanitizedRule = sanitizeUntrustedContent(normalizedRule);
  return `${content}\n[Room Rule] <room-rule>${sanitizedRule}</room-rule>`;
}

export interface InboundParams {
  cfg: any;
  accountId: string;
  senderName: string;
  senderId: string;
  content: string;
  messageId?: string;
  messageType?: MessageType;
  chatType: "direct" | "group";
  groupSubject?: string;
  replyTarget: string;
  roomId?: string;
  topic?: string;
  topicId?: string;
  mentioned?: boolean;
}

/**
 * Shared handler for InboxMessage — used by both WebSocket and Poller paths.
 * Normalizes InboxMessage into InboundParams and dispatches to OpenClaw.
 *
 * Routes differently based on msg.source_type:
 * - "dashboard_user_chat": auto-reply mode (user chat), skips NO_REPLY/loop-risk
 * - default ("agent"): existing A2A flow
 */
export async function handleInboxMessage(
  msg: InboxMessage,
  accountId: string,
  cfg: any,
): Promise<void> {
  const isDashboardUserChat = msg.source_type === "dashboard_user_chat";

  if (isDashboardUserChat) {
    await handleDashboardUserChat(msg, accountId, cfg);
  } else {
    await handleA2AMessage(msg, accountId, cfg);
  }
}

/**
 * Handle dashboard user chat messages — auto-reply mode.
 * No NO_REPLY hints, no A2A loop-risk, replies auto-delivered back to room.
 */
async function handleDashboardUserChat(
  msg: InboxMessage,
  accountId: string,
  cfg: any,
): Promise<void> {
  const core = getBotCordRuntime();
  const envelope = msg.envelope;
  const senderId = envelope.from || "owner";
  const rawContent =
    msg.text ||
    (typeof envelope.payload === "string"
      ? envelope.payload
      : (envelope.payload?.text as string) ?? JSON.stringify(envelope.payload));

  // Owner messages are trusted — pass through as-is without headers or sanitization
  const content = rawContent;

  const replyTarget = msg.room_id || "";
  // All dashboard user-chat sessions share a single fixed key so the
  // conversation context persists across rooms.
  const sessionKey = "botcord:owner:main";

  const route = core.channel.routing.resolveAgentRoute({
    cfg,
    channel: "botcord",
    accountId,
    peer: { kind: "direct", id: replyTarget },
  });

  const from = `botcord:${senderId}`;
  const to = `botcord:${accountId}`;

  const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(cfg);
  const formattedBody = core.channel.reply.formatAgentEnvelope({
    channel: "BotCord",
    from: msg.source_user_name || "Owner",
    timestamp: new Date(),
    envelope: envelopeOptions,
    body: content,
  });

  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: formattedBody,
    BodyForAgent: content,
    RawBody: content,
    CommandBody: content,
    From: from,
    To: to,
    SessionKey: route.sessionKey || sessionKey,
    AccountId: accountId,
    ChatType: "direct",
    SenderName: msg.source_user_name || "Owner",
    SenderId: senderId,
    Provider: "botcord" as const,
    Surface: "botcord" as const,
    MessageSid: envelope.msg_id || `botcord-${Date.now()}`,
    Timestamp: Date.now(),
    WasMentioned: true,
    CommandAuthorized: true,
    OriginatingChannel: "botcord" as const,
    OriginatingTo: to,
    ConversationLabel: msg.source_user_name ? `${msg.source_user_name} Chat` : "Owner Chat",
  });

  // Create the reply dispatcher that sends replies back to the chat room
  const acct = resolveAccountConfig(cfg, accountId);
  const client = new BotCordClient(acct);
  attachTokenPersistence(client, acct);
  const replyDispatcher = createBotCordReplyDispatcher({
    client,
    replyTarget,
  });

  // Use buffered block dispatcher with auto-delivery to the chat room.
  // The deliver callback receives a ReplyPayload object (not a plain string).
  await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg,
    dispatcherOptions: {
      deliver: async (payload: any) => {
        const text = payload?.text ?? "";
        const mediaUrl = payload?.mediaUrl;
        if (mediaUrl) {
          await replyDispatcher.sendMedia(text, mediaUrl);
        } else if (text) {
          await replyDispatcher.sendText(text);
        }
      },
      onError: (err: any, info: any) => {
        console.error(`[botcord] user-chat ${info?.kind ?? "unknown"} reply error:`, err);
      },
    },
    replyOptions: {},
  });
}

/**
 * Handle regular A2A messages — existing flow with NO_REPLY hints and
 * suppressed auto-delivery.
 */
async function handleA2AMessage(
  msg: InboxMessage,
  accountId: string,
  cfg: any,
): Promise<void> {
  const envelope = msg.envelope;
  const senderId = envelope.from || "unknown";
  const rawContent =
    msg.text ||
    (typeof envelope.payload === "string"
      ? envelope.payload
      : (envelope.payload?.text as string) ?? JSON.stringify(envelope.payload));
  // DM rooms have rm_dm_ prefix; only non-DM rooms are true group chats
  const isGroupRoom = !!msg.room_id && !msg.room_id.startsWith("rm_dm_");
  const chatType = isGroupRoom ? "group" : "direct";

  const sanitizedSender = sanitizeSenderName(senderId);
  const header = buildInboundHeader({
    type: envelope.type,
    senderName: sanitizedSender,
    accountId,
    chatType,
    roomName: isGroupRoom ? (msg.room_name || msg.room_id) : undefined,
  });
  const silentHint =
    chatType === "group"
      ? '\n\n[In group chats, do NOT reply unless you are explicitly mentioned or addressed. If no response is needed, reply with exactly "NO_REPLY" and nothing else.]'
      : '\n\n[If the conversation has naturally concluded or no response is needed, reply with exactly "NO_REPLY" and nothing else.]';

  // Prompt the agent to notify its owner when receiving contact requests
  const notifyOwnerHint =
    envelope.type === "contact_request"
      ? `\n\n[You received a contact request from ${sanitizedSender}. Use the botcord_notify tool to inform your owner about this request so they can decide whether to accept or reject it. Include the sender's agent ID and any message they attached.]`
      : "";

  const sanitizedContent = sanitizeUntrustedContent(rawContent);
  const content = `${header}\n<agent-message sender="${sanitizedSender}">\n${sanitizedContent}\n</agent-message>${silentHint}${notifyOwnerHint}`;
  const contentWithRule = isGroupRoom ? appendRoomRule(content, msg.room_rule) : content;

  await dispatchInbound({
    cfg,
    accountId,
    senderName: senderId,
    senderId,
    content: contentWithRule,
    messageId: envelope.msg_id,
    messageType: envelope.type,
    chatType,
    groupSubject: isGroupRoom ? (msg.room_name || msg.room_id) : undefined,
    replyTarget: isGroupRoom ? msg.room_id! : (envelope.from || ""),
    roomId: msg.room_id,
    topic: msg.topic,
    topicId: msg.topic_id,
    mentioned: msg.mentioned,
  });
}

/**
 * Dispatch an inbound message into OpenClaw's channel routing system.
 */
export async function dispatchInbound(params: InboundParams): Promise<void> {
  const core = getBotCordRuntime();
  const {
    cfg,
    accountId,
    senderName,
    senderId,
    content,
    messageId,
    chatType,
    groupSubject,
    replyTarget,
    roomId,
    topic,
  } = params;

  const from = `botcord:${senderId}`;
  const to = `botcord:${accountId}`;
  const sessionKey = buildSessionKey(roomId, topic, senderId);

  const route = core.channel.routing.resolveAgentRoute({
    cfg,
    channel: "botcord",
    accountId,
    peer: {
      kind: chatType,
      id: chatType === "group" ? (roomId || replyTarget) : senderId,
    },
  });

  // Track session → room mapping for cross-session context injection.
  // Register under the *effective* session key (what OpenClaw passes as
  // ctx.sessionKey in hooks).  When routing overrides the key, use that;
  // otherwise fall back to the deterministic BotCord key.
  // Note: if routing merges multiple rooms into one session, last-writer-wins
  // is intentional — the session context already mixes messages from all rooms.
  // Also register DM sessions without a roomId so they appear in digests.
  const effectiveSessionKey = route.sessionKey || sessionKey;
  const peerId = roomId || senderId;
  if (peerId) {
    registerSessionRoom(effectiveSessionKey, {
      roomId: roomId || `rm_dm_${senderId}`,
      roomName: groupSubject || roomId || senderName,
      accountId,
      lastActivityAt: Date.now(),
    });
  }

  const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(cfg);
  const formattedBody = core.channel.reply.formatAgentEnvelope({
    channel: "BotCord",
    from: senderName,
    timestamp: new Date(),
    envelope: envelopeOptions,
    body: content,
  });

  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: formattedBody,
    BodyForAgent: content,
    RawBody: content,
    CommandBody: content,
    From: from,
    To: to,
    SessionKey: route.sessionKey || sessionKey,
    AccountId: accountId,
    ChatType: chatType,
    GroupSubject: chatType === "group" ? (groupSubject || replyTarget) : undefined,
    SenderName: senderName,
    SenderId: senderId,
    Provider: "botcord" as const,
    Surface: "botcord" as const,
    MessageSid: messageId || `botcord-${Date.now()}`,
    Timestamp: Date.now(),
    WasMentioned: params.chatType === "direct"
      ? true
      : (params.mentioned ?? true),
    CommandAuthorized: true,
    OriginatingChannel: "botcord" as const,
    OriginatingTo: to,
    ConversationLabel: chatType === "group" ? (groupSubject || senderName) : senderName,
  });

  await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg,
    dispatcherOptions: {
      // A2A replies are sent explicitly via botcord_send tool.
      // Suppress automatic delivery to avoid leaking agent narration.
      deliver: async () => {},
      onError: (err: any, info: any) => {
        console.error(`[botcord] ${info?.kind ?? "unknown"} reply error:`, err);
      },
    },
    replyOptions: {},
  });

  // Auto-notify owner for notification-type messages (contact requests, etc.)
  // Normal messages are NOT auto-notified; the agent can use the
  // botcord_notify tool to notify the owner when it deems appropriate.
  const messageType = params.messageType;
  if (messageType && NOTIFICATION_TYPES.has(messageType)) {
    const acct = resolveAccountConfig(cfg, accountId);
    const sessions = normalizeNotifySessions(acct.notifySession);
    const childSessionKey = route.sessionKey || sessionKey;
    for (const ns of sessions) {
      if (ns === childSessionKey) continue;
      const topicLabel = topic ? ` (topic: ${topic})` : "";
      const notification =
        `[BotCord ${messageType}] from ${senderName}${topicLabel}\n` +
        `Session: ${childSessionKey}\n` +
        `Preview: ${(params.content || "").slice(0, 200)}`;

      try {
        await deliverNotification(core, cfg, ns, notification);
      } catch (err: any) {
        console.error(`[botcord] auto-notify failed:`, err?.message ?? err);
      }
    }
  }
}

// ── Notification delivery helpers ───────────────────────────────────

type DeliveryContext = {
  channel: string;
  to: string;
  accountId?: string;
  threadId?: string;
};

/**
 * Parse a session key like "agent:pm:telegram:direct:7904063707" into a
 * DeliveryContext.  Returns undefined if the key doesn't contain a
 * recognisable channel segment.
 *
 * Supported formats:
 *   agent:<agentName>:<channel>:direct:<peerId>
 *   agent:<agentName>:<channel>:group:<groupId>
 */
function parseSessionKeyDeliveryContext(sessionKey: string): DeliveryContext | undefined {
  // e.g. ["agent", "pm", "telegram", "direct", "7904063707"]
  const parts = sessionKey.split(":");
  if (parts.length < 5 || parts[0] !== "agent") return undefined;

  const agentName = parts[1]; // e.g. "pm"
  const channel = parts[2];   // e.g. "telegram"
  if (!channel) return undefined;

  const peerId = parts.slice(4).join(":"); // handle colons in id
  if (!peerId) return undefined;

  return {
    channel,
    to: `${channel}:${peerId}`,
    accountId: agentName,
  };
}

function parseSessionStoreDeliveryContext(
  core: ReturnType<typeof getBotCordRuntime>,
  cfg: any,
  sessionKey: string,
): DeliveryContext[] {
  try {
    const storePath = core.channel.session.resolveStorePath(cfg);
    if (!storePath) return [];

    const store = loadSessionStore(storePath);
    const trimmedKey = sessionKey.trim();
    const normalizedKey = trimmedKey.toLowerCase();
    let existing = store[normalizedKey] ?? store[trimmedKey];
    let existingUpdatedAt = existing?.updatedAt ?? 0;

    // Legacy stores may contain differently-cased keys for the same session.
    // Prefer the most recently updated matching entry.
    for (const [candidateKey, candidateEntry] of Object.entries(store)) {
      if (candidateKey.toLowerCase() !== normalizedKey) continue;
      const candidateUpdatedAt = candidateEntry?.updatedAt ?? 0;
      if (!existing || candidateUpdatedAt > existingUpdatedAt) {
        existing = candidateEntry;
        existingUpdatedAt = candidateUpdatedAt;
      }
    }
    if (!existing) return [];

    const lastRoute = {
      channel: existing.lastChannel,
      to: existing.lastTo,
      accountId: existing.lastAccountId,
      threadId: existing.lastThreadId ?? existing.origin?.threadId,
    };
    const candidates: DeliveryContext[] = [];
    for (const ctx of [existing.deliveryContext, lastRoute]) {
      if (!ctx?.channel || !ctx?.to) continue;
      const normalized: DeliveryContext = {
        channel: String(ctx.channel),
        to: String(ctx.to),
      };
      if (ctx.accountId != null) normalized.accountId = String(ctx.accountId);
      if (ctx.threadId != null) normalized.threadId = String(ctx.threadId);
      candidates.push(normalized);
    }

    // Deduplicate identical contexts while preserving order.
    const seen = new Set<string>();
    return candidates.filter((ctx) => {
      const key = `${ctx.channel}|${ctx.to}|${ctx.accountId ?? ""}|${ctx.threadId ?? ""}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  } catch (err: any) {
    console.warn(
      `[botcord] notifySession ${sessionKey}: failed to read deliveryContext from session store:`,
      err?.message ?? err,
    );
    return [];
  }
}

/** Channel name → runtime send function dispatcher. */
type ChannelSendFn = (to: string, text: string, opts: Record<string, unknown>) => Promise<unknown>;

function resolveChannelSendFn(
  core: ReturnType<typeof getBotCordRuntime>,
  channel: string,
): ChannelSendFn | undefined {
  const map: Record<string, ChannelSendFn | undefined> = {
    telegram: core.channel.telegram?.sendMessageTelegram as ChannelSendFn | undefined,
    discord: core.channel.discord?.sendMessageDiscord as ChannelSendFn | undefined,
    slack: core.channel.slack?.sendMessageSlack as ChannelSendFn | undefined,
    whatsapp: core.channel.whatsapp?.sendMessageWhatsApp as ChannelSendFn | undefined,
    signal: core.channel.signal?.sendMessageSignal as ChannelSendFn | undefined,
    imessage: core.channel.imessage?.sendMessageIMessage as ChannelSendFn | undefined,
  };
  return map[channel];
}

/**
 * Deliver a notification message directly to the channel associated with
 * the target session. Prefer deriving target from session key; fallback to
 * session store deliveryContext when direct routing is unavailable.
 */
export async function deliverNotification(
  core: ReturnType<typeof getBotCordRuntime>,
  cfg: any,
  sessionKey: string,
  text: string,
): Promise<void> {
  const deliveryFromKey = parseSessionKeyDeliveryContext(sessionKey);
  const storeCandidates = parseSessionStoreDeliveryContext(core, cfg, sessionKey);
  const candidates = [
    ...(deliveryFromKey ? [deliveryFromKey] : []),
    ...storeCandidates,
  ];
  let delivery: DeliveryContext | undefined;
  let sendFn: ChannelSendFn | undefined;

  for (const candidate of candidates) {
    if (!delivery) delivery = candidate;
    const resolved = resolveChannelSendFn(core, candidate.channel);
    if (resolved) {
      delivery = candidate;
      sendFn = resolved;
      break;
    }
  }

  if (!delivery) {
    console.warn(
      `[botcord] notifySession ${sessionKey}: cannot derive delivery target from session key or session store — skipping notification`,
    );
    return;
  }

  if (!sendFn) {
    sendFn = resolveChannelSendFn(core, delivery.channel);
  }
  if (!sendFn) {
    console.warn(
      `[botcord] unsupported notify channel "${delivery.channel}" — skipping notification`,
    );
    return;
  }

  await sendFn(delivery.to, text, {
    cfg,
    accountId: delivery.accountId,
    threadId: delivery.threadId,
  });
}
