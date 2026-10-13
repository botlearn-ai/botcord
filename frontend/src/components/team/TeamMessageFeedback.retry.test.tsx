// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DashboardMessage } from "@/lib/types";
const mock = vi.hoisted(() => ({ send: vi.fn(), messages: {} as Record<string, DashboardMessage[]> }));
vi.mock("@/lib/i18n", () => ({ useLanguage: () => "zh" }));
vi.mock("@/lib/room-message-send", () => ({ sendDashboardRoomMessage: mock.send }));
vi.mock("@/store/useDashboardChatStore", () => ({ useDashboardChatStore: { getState: () => ({ messages: mock.messages }) } }));
import { MessageFeedback } from "./TeamMessageFeedback";
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: ReturnType<typeof createRoot>;
const base = { hub_msg_id: "h1", msg_id: "m1", room_id: "r", is_mine: true, sender_kind: "human", created_at: new Date().toISOString(),
  send_request_id: "old-accepted-key", reply_activity: [
    { agent_id: "a", agent_name: "A", status: "failed" },
    { agent_id: "b", agent_name: "B", status: "completed" },
    { agent_id: "c", agent_name: "C", status: "unconfirmed", basis: "run" },
  ] } as DashboardMessage;
beforeEach(() => { mock.send.mockReset(); mock.send.mockResolvedValue(undefined); mock.messages = { r: [base] }; });
afterEach(() => { if (root) act(() => root.unmount()); document.body.innerHTML = ""; });
function mount(message = base) {
  const host = document.createElement("div"); document.body.append(host);
  root = createRoot(host); act(() => root.render(<MessageFeedback message={message} />));
  return host;
}
it("uses a new request key only for a deliberate execution retry and targets failed agents", async () => {
  const host = mount();
  await act(async () => { host.querySelector("button")!.click(); });
  expect(mock.send).toHaveBeenCalledTimes(1);
  const sent = mock.send.mock.calls[0][0];
  expect(sent.mentions).toEqual(["a"]);
  expect(sent.send_request_id).not.toBe("old-accepted-key");
  expect(sent.send_request_id).toBe(sent.hub_msg_id);
  expect(host.querySelector("button")).toBeNull();
});
it("rechecks current store state instead of retrying an already completed agent", async () => {
  const host = mount();
  mock.messages.r = [{ ...base, reply_activity: base.reply_activity!.map((a) => ({ ...a, status: "completed" })) }];
  await act(async () => { host.querySelector("button")!.click(); });
  expect(mock.send).not.toHaveBeenCalled();
});
it("preserves the request key after ambiguous send failure and blocks synchronous double clicks", async () => {
  const failed = { ...base, hub_msg_id: "tmp_key", msg_id: "tmp_key", send_request_id: "same-key", send_status: "failed", state: "failed", reply_activity: undefined } as DashboardMessage;
  mock.messages.r = [failed];
  const host = mount(failed);
  await act(async () => { const button = host.querySelector("button")!; button.click(); button.click(); });
  expect(mock.send).toHaveBeenCalledTimes(1);
  expect(mock.send.mock.calls[0][0].send_request_id).toBe("same-key");
});
it("leaves a failed execution-resend to its new bubble instead of minting more request keys", async () => {
  mock.send.mockRejectedValue(new Error("response lost"));
  const host = mount();
  await act(async () => { host.querySelector("button")!.click(); });
  expect(host.textContent).toContain("response lost");
  expect(host.querySelector("button")).toBeNull();
});
