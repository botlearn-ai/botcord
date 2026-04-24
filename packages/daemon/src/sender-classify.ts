/**
 * Sender classification helper — shared between the daemon's activity
 * recorder (daemon.ts) and the user-turn composer (turn-text.ts).
 *
 * Lives in its own module so both callers can import it without forming a
 * dependency cycle through daemon.ts.
 */
import type { GatewayInboundMessage } from "./gateway/index.js";

/**
 * BotCord owner-chat room prefix. Rooms with this prefix are direct-message
 * rooms between an operator and their own agent; turns here are treated as
 * owner-trust by the daemon's trust classifier.
 */
export const OWNER_CHAT_PREFIX = "rm_oc_";

/**
 * Map a gateway inbound message to a sender label + kind.
 *
 * The gateway BotCord channel collapses two distinct owner-trust cases
 * (`rm_oc_` rooms AND `source_type === "dashboard_user_chat"`) into a single
 * `sender.kind === "user"` marker — which also covers `dashboard_human_room`
 * humans. We need them separated here so callers can distinguish "owner"
 * (admin, fully trusted) from "human Alice" (a regular human in a normal
 * room). Falling back to just the `rm_oc_` prefix when `raw` is an
 * unexpected shape keeps the classifier working even if a non-BotCord
 * channel is later plugged in.
 */
export function classifyActivitySender(
  msg: GatewayInboundMessage,
): { kind: "agent" | "human" | "owner"; label: string } {
  const sourceType =
    msg.raw && typeof msg.raw === "object" && "source_type" in msg.raw
      ? (msg.raw as { source_type?: unknown }).source_type
      : undefined;
  const isOwner =
    msg.conversation.id.startsWith(OWNER_CHAT_PREFIX) ||
    sourceType === "dashboard_user_chat";
  if (isOwner) {
    return { kind: "owner", label: msg.sender.name || msg.sender.id || "owner" };
  }
  if (msg.sender.kind === "user") {
    return { kind: "human", label: msg.sender.name || msg.sender.id || "user" };
  }
  return { kind: "agent", label: msg.sender.id || "unknown" };
}
