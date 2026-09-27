/** Synchronous owned-Bot chat navigation; the message pane owns room resolution. */
import type { UserAgent } from "@/lib/types";
import { useDashboardChatStore } from "@/store/useDashboardChatStore";
import { useDashboardUIStore } from "@/store/useDashboardUIStore";
import { findCachedOwnerChatRoom } from "@/store/useOwnerChatStore";

export function openOwnerChat(
  bot: Pick<UserAgent, "agent_id" | "display_name">,
  push: (path: string) => void,
): void {
  const room = findCachedOwnerChatRoom(bot.agent_id);
  const ui = useDashboardUIStore.getState();
  const chat = useDashboardChatStore.getState();
  ui.setMessagesPane("user-chat");
  ui.setUserChatAgentId(bot.agent_id);
  ui.setUserChatRoomId(room?.room_id ?? null);
  ui.setFocusedRoomId(null);
  ui.setOpenedRoomId(null);
  chat.upsertOptimisticOwnerChatRoom(bot, room?.room_id);
  const path = "/chats/messages";
  ui.startPrimaryNavigation("messages", path);
  push(path);
  // No async continuation may retarget navigation after the reader moves on.
  if (room) void chat.prefetchRoomMessages(room.room_id);
}
