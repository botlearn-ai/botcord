import type { OwnerChatMessage } from "@/lib/types";

type OwnerChatActionMessage = Pick<OwnerChatMessage, "createdAt" | "senderName" | "status" | "text" | "type">;

export function canShowOwnerChatMessageActions(message: OwnerChatActionMessage): boolean {
  return message.type === "message"
    && message.status !== "streaming"
    && message.text.trim().length > 0;
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
