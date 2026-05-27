/** Shared utilities for cross-component message navigation (jump-to-message,
 *  scroll + highlight). Decoupled via DOM CustomEvent so MessageBubble doesn't
 *  need to know about MessageList's scroll container. */

export const JUMP_TO_MESSAGE_EVENT = "botcord:jump-to-message";

export interface JumpToMessageDetail {
  msgId: string;
  roomId?: string;
}

export function emitJumpToMessage(detail: JumpToMessageDetail): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<JumpToMessageDetail>(JUMP_TO_MESSAGE_EVENT, { detail }));
}
