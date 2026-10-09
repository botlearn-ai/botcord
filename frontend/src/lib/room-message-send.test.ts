import { beforeEach, expect, it, vi } from "vitest";
import type { DashboardMessage } from "@/lib/types";
const mocks = vi.hoisted(() => ({ send: vi.fn(), insert: vi.fn(), poll: vi.fn(), patch: vi.fn(), state: { messages: {} as Record<string, DashboardMessage[]> } }));
vi.mock("@/lib/api", () => ({ api: { sendRoomHumanMessage: mocks.send } }));
vi.mock("@/store/useDashboardChatStore", () => ({ useDashboardChatStore: {
  getState: () => ({ insertMessage: mocks.insert, pollNewMessages: mocks.poll, patchRoom: mocks.patch }),
  setState: (update: (s: typeof mocks.state) => typeof mocks.state) => { mocks.state = update(mocks.state); },
} }));
import { sendDashboardRoomMessage } from "./room-message-send";
const message = { hub_msg_id: "tmp_1", msg_id: "tmp_1", room_id: "rm_1", text: "hello", payload: { text: "hello", attachments: [{ url: "/file" }] }, mentions: ["ag_1"], topic_id: "tp_1", retry_reply_to: "quoted", created_at: "2026-10-09T00:00:00Z" } as unknown as DashboardMessage;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.state = { messages: { rm_1: [message] } };
  mocks.poll.mockResolvedValue(undefined);
});
it("preserves attachments, mentions and quote when retrying the same bubble", async () => {
  mocks.send.mockRejectedValueOnce(new Error("offline"));
  await expect(sendDashboardRoomMessage(message)).rejects.toThrow("offline");
  expect(mocks.state.messages.rm_1[0].send_status).toBe("failed");
  mocks.send.mockResolvedValueOnce({ hub_msg_id: "h_1", msg_id: "m_1" });
  await sendDashboardRoomMessage(mocks.state.messages.rm_1[0]);
  expect(mocks.send).toHaveBeenLastCalledWith("rm_1", "hello", ["ag_1"], "tp_1", message.payload.attachments, "quoted");
  expect(mocks.state.messages.rm_1).toHaveLength(1);
  expect(mocks.state.messages.rm_1[0]).toMatchObject({ hub_msg_id: "h_1", send_status: "sent", send_error: undefined });
});
it("guards double-click sends while the first request is pending", async () => {
  let finish!: (v: unknown) => void;
  mocks.send.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const first = sendDashboardRoomMessage(message);
  expect(mocks.state.messages.rm_1[0].send_status).toBe("sending");
  await sendDashboardRoomMessage(message);
  expect(mocks.send).toHaveBeenCalledTimes(1);
  finish({ hub_msg_id: "h_1", msg_id: "m_1" });
  await first;
});
