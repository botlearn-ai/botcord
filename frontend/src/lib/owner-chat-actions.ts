import type { OwnerChatMessage, ReplyPreview } from "@/lib/types";

type OwnerChatActionMessage = Pick<OwnerChatMessage, "createdAt" | "hubMsgId" | "senderName" | "status" | "text" | "type">;

export function ownerChatReplyTargetId(
  message: Pick<OwnerChatMessage, "hubMsgId">,
): string | null {
  return message.hubMsgId || null;
}

export function canShowOwnerChatMessageActions(message: OwnerChatActionMessage): boolean {
  return message.type === "message"
    && message.status !== "streaming"
    && message.text.trim().length > 0;
}

export function canReplyToOwnerChatMessage(message: OwnerChatActionMessage): boolean {
  return message.type === "message"
    && (message.status === "confirmed" || message.status === "delivered")
    && message.text.trim().length > 0
    && Boolean(ownerChatReplyTargetId(message));
}

export function buildOwnerChatReplyPreview(
  message: Pick<OwnerChatMessage, "hubMsgId" | "senderName" | "text">,
): ReplyPreview | null {
  const msgId = ownerChatReplyTargetId(message);
  if (!msgId) return null;

  return {
    msg_id: msgId,
    sender_id: null,
    sender_display_name: message.senderName || null,
    text_preview: (message.text || "").slice(0, 120) || null,
    topic_id: null,
    deleted: false,
  };
}

export function buildOwnerChatForwardQuote(
  message: Pick<OwnerChatMessage, "createdAt" | "senderName" | "text">,
  formatTime: (createdAt: string) => string = (createdAt) =>
    new Date(createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
): string {
  const sender = message.senderName || "Owner chat";
  const body = message.text.split("\n").map((line) => `> ${line}`).join("\n");
  return `> [转发自 ${sender} · ${formatTime(message.createdAt)}]\n${body}\n`;
}
