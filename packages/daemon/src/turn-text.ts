/**
 * User-turn text composer for the gateway dispatcher.
 *
 * Wraps raw `msg.text` with channel-relevant metadata before handing it to
 * the runtime. The wrapped text lands in the runtime transcript, so the
 * model can recover "who sent this / what room / was I mentioned" on every
 * later turn via `--resume`.
 *
 * Shape mirrors the plugin's `handleA2AGroup` output (see
 * `plugin/src/inbound.ts`) so Claude Code behaves the same way in daemon as
 * it does when hosted by OpenClaw:
 *
 *   [BotCord Message] | from: ag_alice | to: ag_me | room: Ouraca Team
 *   <agent-message sender="ag_alice" sender_kind="agent">
 *   hello
 *   </agent-message>
 *
 *   [In group chats, do NOT reply unless you are explicitly mentioned or
 *    addressed. If no response is needed, reply with exactly "NO_REPLY"
 *    and nothing else.]
 *
 * Owner-chat messages bypass the wrapper entirely — they are trusted and
 * the owner-chat scene prompt in `system-context.ts` already gives the
 * model the context it needs.
 */
import type { GatewayInboundMessage } from "./gateway/index.js";
import { sanitizeSenderName, sanitizeUntrustedContent } from "./gateway/index.js";
import { classifyActivitySender } from "./sender-classify.js";

const GROUP_HINT =
  '[In group chats, do NOT reply unless you are explicitly mentioned or addressed. ' +
  'If no response is needed, reply with exactly "NO_REPLY" and nothing else.]';
const DIRECT_HINT =
  '[If the conversation has naturally concluded or no response is needed, ' +
  'reply with exactly "NO_REPLY" and nothing else.]';

/**
 * Reminder appended to wrapped BotCord network rooms that are not owner-chat.
 * The dispatcher discards `result.text` for those rooms, so the agent must
 * call the `botcord_send` tool (or the `botcord send` CLI via Bash) to
 * actually deliver a reply. Plain assistant text in those rooms is logged
 * and dropped.
 */
const NON_OWNER_REPLY_HINT =
  "[This room is NOT owner-chat. Plain text output WILL NOT be sent. " +
  "To reply, call the `botcord_send` tool, or run " +
  '`botcord send --room <room_id> --text "..."` via Bash.]';
const THIRD_PARTY_REPLY_HINT =
  "[This is a third-party gateway chat. Reply normally in your final assistant " +
  "message; BotCord daemon will deliver that text through the same channel. " +
  "No extra send tool is required for this chat.]";

/**
 * Read the BotCord envelope type from a raw inbound message. Returns
 * `undefined` when the message didn't come from the BotCord channel or the
 * raw shape is unexpected — callers treat that the same as "message".
 */
function readEnvelopeType(raw: unknown): string | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const env = (raw as { envelope?: unknown }).envelope;
  if (!env || typeof env !== "object") return undefined;
  const t = (env as { type?: unknown }).type;
  return typeof t === "string" ? t : undefined;
}

function isThirdPartyConversation(conversationId: string): boolean {
  return (
    conversationId.startsWith("telegram:") ||
    conversationId.startsWith("wechat:")
  );
}

function replyDeliveryHint(msg: GatewayInboundMessage): string {
  return isThirdPartyConversation(msg.conversation.id)
    ? THIRD_PARTY_REPLY_HINT
    : NON_OWNER_REPLY_HINT;
}

/** Minimal shape of one batched inbound entry. Matches the BotCord channel
 * `BatchedInboxRaw.batch[]` elements but expressed structurally so the
 * composer doesn't import channel internals. */
interface BatchedEntry {
  hub_msg_id?: unknown;
  text?: unknown;
  envelope?: { from?: unknown; type?: unknown; payload?: { text?: unknown } };
  source_type?: unknown;
  source_user_name?: unknown;
  mentioned?: unknown;
}

/**
 * Read the `raw.batch` array emitted by the BotCord channel when inbox
 * drain groups multiple messages for the same `(room, topic)`. Returns the
 * list when present and well-shaped, else null. Single-message envelopes
 * have no `batch` field and fall through to the single-message path.
 */
function readBatch(raw: unknown): BatchedEntry[] | null {
  if (!raw || typeof raw !== "object") return null;
  const b = (raw as { batch?: unknown }).batch;
  if (!Array.isArray(b) || b.length < 2) return null;
  return b as BatchedEntry[];
}

function entryFromLabel(e: BatchedEntry): {
  label: string;
  kind: "human" | "agent";
  envelopeType: string | undefined;
} {
  const envType = typeof e.envelope?.type === "string" ? e.envelope.type : undefined;
  const isHuman =
    e.source_type === "dashboard_human_room" ||
    (typeof e.envelope?.from === "string" && e.envelope.from.startsWith("hu_"));
  const fromId = typeof e.envelope?.from === "string" ? e.envelope.from : "unknown";
  const label = isHuman
    ? typeof e.source_user_name === "string" && e.source_user_name
      ? e.source_user_name
      : "User"
    : fromId;
  return { label, kind: isHuman ? "human" : "agent", envelopeType: envType };
}

function entryText(e: BatchedEntry): string {
  if (typeof e.text === "string") return e.text;
  if (typeof e.envelope?.payload?.text === "string") return e.envelope.payload.text;
  return "";
}

/**
 * Compose the user-turn text for a BotCord inbound message.
 *
 * Contract (from `UserTurnBuilder`):
 *   - Must be synchronous + cheap (turn critical path).
 *   - Caller guarantees `msg.text` is already trim-non-empty.
 *   - Never throws on expected inputs. If something unforeseen happens the
 *     dispatcher falls back to the raw trimmed text.
 */
export function composeBotCordUserTurn(msg: GatewayInboundMessage): string {
  const rawText = typeof msg.text === "string" ? msg.text : "";
  const trimmed = rawText.trim();
  if (!trimmed) return trimmed;

  const sender = classifyActivitySender(msg);

  // Owner messages pass through verbatim. The scene prompt in
  // system-context handles context; wrapping here would just add noise.
  if (sender.kind === "owner") return trimmed;

  const batch = readBatch(msg.raw);
  if (batch) {
    return composeBatchedTurn(msg, batch);
  }

  const conversation = msg.conversation;
  const isGroup = conversation.kind === "group";
  const roomTitle =
    typeof conversation.title === "string" ? conversation.title : undefined;

  // Sanitize every field that could carry prompt-injection markers. The
  // text itself is already sanitized by the channel when
  // sender.kind !== "owner"; re-sanitizing is a no-op but keeps the
  // contract local (the composer does not trust its inputs).
  const sanitizedSenderLabel = sanitizeSenderName(sender.label);
  const headerFields: string[] = [
    "[BotCord Message]",
    `from: ${sanitizedSenderLabel}`,
    `to: ${msg.accountId}`,
  ];
  if (isGroup && roomTitle) {
    const safeRoom = sanitizeSenderName(roomTitle.replace(/[\r\n]+/g, " "));
    headerFields.push(`room: ${safeRoom}`);
  }
  if (msg.mentioned) {
    headerFields.push("mentioned: true");
  }

  const tag = sender.kind === "human" ? "human-message" : "agent-message";
  const senderKindAttr = sender.kind === "human" ? "human" : "agent";

  const hint = isGroup ? GROUP_HINT : DIRECT_HINT;

  // Contact-request envelopes travel through the same "inbound message"
  // path as regular messages, but carry an additional expectation: the
  // agent should surface the request to its owner rather than auto-accept
  // or auto-reject. Mirrors `plugin/src/inbound.ts` §handleA2ASingle.
  const isContactRequest = readEnvelopeType(msg.raw) === "contact_request";
  const contactRequestHint = isContactRequest
    ? "[You received a contact request from " +
      sanitizedSenderLabel +
      ". Use the botcord_notify tool to inform your owner about this request so " +
      "they can decide whether to accept or reject it. Include the sender's " +
      "agent ID and any message they attached.]"
    : null;

  const lines: string[] = [
    headerFields.join(" | "),
    `<${tag} sender="${sanitizedSenderLabel}" sender_kind="${senderKindAttr}">`,
    trimmed,
    `</${tag}>`,
    "",
    hint,
    "",
    replyDeliveryHint(msg),
  ];
  if (contactRequestHint) {
    lines.push("", contactRequestHint);
  }
  return lines.join("\n");
}

/**
 * Render a batched turn (≥2 messages from the same room/topic folded into
 * one envelope by `botcord.ts:normalizeInboxBatch`). Mirrors plugin's
 * `handleA2AGroup` output shape so Claude Code sees the same prompt
 * whether driven by OpenClaw or by daemon.
 */
function composeBatchedTurn(
  msg: GatewayInboundMessage,
  batch: BatchedEntry[],
): string {
  const conversation = msg.conversation;
  const isGroup = conversation.kind === "group";
  const roomTitle =
    typeof conversation.title === "string" ? conversation.title : undefined;

  const header: string[] = [
    `[BotCord Messages (${batch.length} new)]`,
    `to: ${msg.accountId}`,
  ];
  if (isGroup && roomTitle) {
    const safeRoom = sanitizeSenderName(roomTitle.replace(/[\r\n]+/g, " "));
    header.push(`room: ${safeRoom}`);
  }
  if (msg.mentioned) {
    header.push("mentioned: true");
  }

  const blocks: string[] = [];
  const contactRequestSenders: string[] = [];
  for (const entry of batch) {
    const { label, kind, envelopeType } = entryFromLabel(entry);
    const safeLabel = sanitizeSenderName(label);
    const raw = entryText(entry);
    // Owner-trust bypass is handled at the outer level — by the time we
    // reach a batched turn the sender classifier has already returned
    // non-owner. Still sanitize defensively.
    const safeBody = sanitizeUntrustedContent(raw);
    const tag = kind === "human" ? "human-message" : "agent-message";
    blocks.push(
      `<${tag} sender="${safeLabel}" sender_kind="${kind}">\n${safeBody}\n</${tag}>`,
    );
    if (envelopeType === "contact_request") {
      contactRequestSenders.push(safeLabel);
    }
  }

  const hint = isGroup ? GROUP_HINT : DIRECT_HINT;
  const lines: string[] = [
    header.join(" | "),
    blocks.join("\n"),
    "",
    hint,
    "",
    replyDeliveryHint(msg),
  ];

  if (contactRequestSenders.length > 0) {
    // Dedup + list — multiple distinct senders show as "A, B".
    const unique = Array.from(new Set(contactRequestSenders));
    lines.push(
      "",
      "[You received a contact request from " +
        unique.join(", ") +
        ". Use the botcord_notify tool to inform your owner about this request so " +
        "they can decide whether to accept or reject it. Include the sender's " +
        "agent ID and any message they attached.]",
    );
  }
  return lines.join("\n");
}
