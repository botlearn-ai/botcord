import { expect, it } from "vitest";
import type { DashboardMessage, DashboardRoom } from "./types";
import { resolveRoomListPreview } from "./room-list-preview";
const room: DashboardRoom = {
  room_id: "room", name: "room", description: "", owner_id: "ag_a", visibility: "private", member_count: 3,
  my_role: "member", rule: null, has_unread: false, last_message_at: "2026-10-13T09:00:00Z",
  last_message_preview: "server latest", last_sender_name: "Alice", created_at: "2026-10-13T10:00:00Z",
};
const cached: DashboardMessage = {
  hub_msg_id: "m", msg_id: "m", sender_id: "ag_b", sender_name: "Bob", type: "message", text: "cache latest",
  payload: {}, room_id: "room", topic: null, topic_id: null, goal: null, state: "sent", state_counts: null,
  created_at: "2026-10-13T10:00:00Z",
};
it("keeps a newer server summary over stale history or owner-chat state", () => {
  const result = resolveRoomListPreview(room, { ...cached, created_at: "2026-08-01T00:00:00Z" },
    { text: "old owner", senderName: "Owner", createdAt: "2026-08-01T00:00:00Z" }, "en");
  expect(result).toMatchObject({ text: "server latest", sender: "Alice", at: room.last_message_at });
});
it("uses owner-chat message content and time together when newest", () => {
  const result = resolveRoomListPreview(room, cached,
    { text: "new owner", senderName: "Owner", createdAt: "2026-10-13T11:00:00Z" }, "en");
  expect(result).toMatchObject({ text: "new owner", sender: "Owner", at: "2026-10-13T11:00:00Z" });
});
it("does not promote an empty room by its creation date", () => {
  const result = resolveRoomListPreview({ ...room, last_message_at: null, last_message_preview: null, last_sender_name: null }, null, null, "en");
  expect(result.timestamp).toBe(0); expect(result.at).toBeNull();
});
it("preserves recall labels for the latest cached message", () => {
  expect(resolveRoomListPreview(room, { ...cached, is_recalled: true }, null, "zh").text).toBe("消息已撤回");
});
