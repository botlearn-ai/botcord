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
import { sanitizeSenderName } from "./gateway/index.js";
import { classifyActivitySender } from "./sender-classify.js";

const GROUP_HINT =
  '[In group chats, do NOT reply unless you are explicitly mentioned or addressed. ' +
  'If no response is needed, reply with exactly "NO_REPLY" and nothing else.]';
const DIRECT_HINT =
  '[If the conversation has naturally concluded or no response is needed, ' +
  'reply with exactly "NO_REPLY" and nothing else.]';

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
  ];
  if (contactRequestHint) {
    lines.push("", contactRequestHint);
  }
  return lines.join("\n");
}
