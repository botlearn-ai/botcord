/**
 * Inbound message dispatch — shared by websocket and polling paths.
 * Converts BotCord messages to OpenClaw inbound format.
 */
import { readFile, readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { getBotCordRuntime } from "./runtime.js";
import { resolveAccountConfig } from "./config.js";
import { buildSessionKey } from "./session-key.js";
import type { InboxMessage, MessageType } from "./types.js";

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
  return `${content}\n[Room Rule] ${normalizedRule}`;
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
 */
export async function handleInboxMessage(
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
      : envelope.payload?.text ?? JSON.stringify(envelope.payload));
  // DM rooms have rm_dm_ prefix; only non-DM rooms are true group chats
  const isGroupRoom = !!msg.room_id && !msg.room_id.startsWith("rm_dm_");
  const chatType = isGroupRoom ? "group" : "direct";

  const header = buildInboundHeader({
    type: envelope.type,
    senderName: senderId,
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
      ? `\n\n[You received a contact request from ${senderId}. Use the botcord_notify tool to inform your owner about this request so they can decide whether to accept or reject it. Include the sender's agent ID and any message they attached.]`
      : "";

  const content = `${header}\n${rawContent}${silentHint}${notifyOwnerHint}`;
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
    const notifySession = acct.notifySession;
    if (notifySession) {
      const childSessionKey = route.sessionKey || sessionKey;
      if (childSessionKey !== notifySession) {
        const topicLabel = topic ? ` (topic: ${topic})` : "";
        const notification =
          `[BotCord ${messageType}] from ${senderName}${topicLabel}\n` +
          `Session: ${childSessionKey}\n` +
          `Preview: ${(params.content || "").slice(0, 200)}`;

        try {
          await deliverNotification(core, cfg, notifySession, notification);
        } catch (err: any) {
          console.error(`[botcord] auto-notify failed:`, err?.message ?? err);
        }
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
 * Read deliveryContext for a session key from the session store on disk.
 * First checks the current agent's store, then scans all agent stores
 * (the session key may belong to a different agent than the one running
 * this plugin).
 * Returns undefined when the session has no recorded delivery route.
 */
async function resolveSessionDeliveryContext(
  core: ReturnType<typeof getBotCordRuntime>,
  cfg: any,
  sessionKey: string,
): Promise<DeliveryContext | undefined> {
  const tryStore = async (path: string): Promise<DeliveryContext | undefined> => {
    try {
      const raw = await readFile(path, "utf-8");
      const store: Record<string, { deliveryContext?: DeliveryContext }> =
        JSON.parse(raw);
      const entry = store[sessionKey];
      if (entry?.deliveryContext?.channel && entry.deliveryContext.to) {
        return entry.deliveryContext;
      }
    } catch {
      // store may not exist yet
    }
    return undefined;
  };

  // 1. Try the current agent's store first (fast path)
  try {
    const storePath = core.channel.session.resolveStorePath(cfg.session?.store);
    const result = await tryStore(storePath);
    if (result) return result;

    // 2. Scan sibling agent stores: walk up to the agents/ dir and check each
    //    storePath is typically  .../.openclaw/agents/<name>/sessions/sessions.json
    const agentsDir = dirname(dirname(dirname(storePath)));
    const entries = await readdir(agentsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const candidate = join(agentsDir, entry.name, "sessions", "sessions.json");
      if (candidate === storePath) continue; // already checked
      const result = await tryStore(candidate);
      if (result) return result;
    }
  } catch {
    // best-effort
  }
  return undefined;
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
 * the target session (looked up via deliveryContext in the session store).
 * Does not trigger an agent turn — just sends the text.
 */
export async function deliverNotification(
  core: ReturnType<typeof getBotCordRuntime>,
  cfg: any,
  sessionKey: string,
  text: string,
): Promise<void> {
  const delivery = await resolveSessionDeliveryContext(core, cfg, sessionKey);
  if (!delivery) {
    console.warn(
      `[botcord] notifySession ${sessionKey} has no deliveryContext — skipping notification`,
    );
    return;
  }

  const sendFn = resolveChannelSendFn(core, delivery.channel);
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
