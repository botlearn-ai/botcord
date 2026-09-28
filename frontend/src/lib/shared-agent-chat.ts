/** Open the human ↔ agent DM for an Agent another member shared with you. */
import { api } from "@/lib/api";
import { useDashboardChatStore } from "@/store/useDashboardChatStore";
import { useDashboardSessionStore } from "@/store/useDashboardSessionStore";
import { useDashboardUIStore } from "@/store/useDashboardUIStore";

export async function openSharedAgentChat(
  agentId: string,
  push: (path: string) => void,
): Promise<string> {
  // The Hub admits grantees to the DM even without a contact relationship.
  const { room_id } = await api.openDmRoom(agentId);
  await Promise.allSettled([
    useDashboardSessionStore.getState().refreshHumanRooms(),
    useDashboardChatStore.getState().refreshOverview(),
  ]);
  const ui = useDashboardUIStore.getState();
  ui.setMessagesPane("room");
  ui.setUserChatAgentId(null);
  ui.setFocusedRoomId(room_id);
  ui.setOpenedRoomId(room_id);
  // Keep the room in the URL so a refresh (or a shared link) reopens the DM.
  const path = `/chats/messages/${encodeURIComponent(room_id)}`;
  ui.startPrimaryNavigation("messages", path);
  push(path);
  void useDashboardChatStore.getState().loadRoomMessages(room_id);
  return room_id;
}
