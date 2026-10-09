import { api } from "@/lib/api";
import type { Attachment, DashboardMessage } from "@/lib/types";
import { useDashboardChatStore } from "@/store/useDashboardChatStore";

const sending = new Set<string>();

/** Reuse a failed optimistic bubble; preserve the payload, mentions and quote. */
export async function sendDashboardRoomMessage(message: DashboardMessage): Promise<void> {
  const roomId = message.room_id;
  if (!roomId || sending.has(message.hub_msg_id)) return;
  sending.add(message.hub_msg_id);
  const patch = (values: Partial<DashboardMessage>) => useDashboardChatStore.setState((state) => ({
    messages: { ...state.messages, [roomId]: (state.messages[roomId] || []).map((m) =>
      m.hub_msg_id === message.hub_msg_id ? { ...m, ...values } : m
    ) },
  }));
  useDashboardChatStore.getState().insertMessage(roomId, message);
  patch({ send_status: "sending", send_error: undefined, state: "queued" });
  try {
    const result = await api.sendRoomHumanMessage(
      roomId,
      typeof message.payload.text === "string" ? message.payload.text : message.text,
      message.mentions ?? undefined,
      message.topic_id,
      message.payload.attachments as Attachment[] | undefined,
      message.retry_reply_to ?? message.reply_preview?.msg_id,
    );
    patch({
      hub_msg_id: result.hub_msg_id,
      msg_id: result.msg_id ?? result.hub_msg_id,
      topic_id: result.topic_id ?? message.topic_id,
      send_status: "sent",
    });
    const store = useDashboardChatStore.getState();
    store.patchRoom(roomId, {
      last_message_preview: message.text,
      last_message_at: message.created_at,
      last_sender_name: message.display_sender_name || message.sender_name,
    });
    // Refresh failures do not turn a successfully accepted send into a failure.
    void store.pollNewMessages(roomId, { expectedHubMsgId: result.hub_msg_id, retries: 4 });
  } catch (error) {
    patch({ send_status: "failed", state: "failed", send_error: error instanceof Error ? error.message : "Failed to send" });
    throw error;
  } finally {
    sending.delete(message.hub_msg_id);
  }
}
