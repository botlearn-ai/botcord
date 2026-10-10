// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DashboardMessage } from "@/lib/types";
const send = vi.hoisted(() => vi.fn());
vi.mock("@/lib/i18n", () => ({ useLanguage: () => "zh" }));
vi.mock("@/lib/room-message-send", () => ({ sendDashboardRoomMessage: send }));
import { MessageFeedback } from "./TeamMessageFeedback";
let container: HTMLDivElement;
let root: Root;
let message: DashboardMessage;
beforeEach(() => {
  vi.useFakeTimers();
  send.mockReset().mockResolvedValue(undefined);
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  message = { hub_msg_id: "h_1", msg_id: "m_1", room_id: "rm_1", sender_kind: "human", is_mine: true, payload: { text: "help", attachments: [{ url: "/file" }] }, retry_reply_to: "quote", created_at: new Date().toISOString(), reply_activity: [{ agent_id: "ag_1", agent_name: "A", status: "processing" }] } as unknown as DashboardMessage;
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});
it("adds the long-wait hint after 15 seconds without inventing a failure, and clears on completion", () => {
  act(() => root.render(<MessageFeedback message={message} />));
  expect(container.textContent).not.toContain("你可以继续发送消息");
  act(() => vi.advanceTimersByTime(15000));
  expect(container.textContent).toContain("你可以继续发送消息");
  expect(container.textContent).not.toContain("失败");
  act(() => root.render(<MessageFeedback message={{ ...message, reply_activity: [{ ...message.reply_activity![0], status: "completed" }] }} />));
  expect(container.textContent).not.toContain("正在处理");
  expect(container.textContent).not.toContain("你可以继续发送消息");
});
it("retries only failed agents while retaining the message payload and quote", async () => {
  message.reply_activity = [{ agent_id: "ag_1", agent_name: "A", status: "completed" }, { agent_id: "ag_2", agent_name: "B", status: "failed" }];
  act(() => root.render(<MessageFeedback message={message} />));
  await act(async () => container.querySelector("button")!.click());
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ mentions: ["ag_2"], payload: message.payload, retry_reply_to: "quote" }));
  expect(container.querySelector("button")).toBeNull();
  expect(container.textContent).toContain("已重新发送");
});

it("navigates from a completed request to its final reply", () => {
  const listener = vi.fn();
  window.addEventListener("botcord:jump-to-message", listener);
  message.reply_activity = [{ agent_id: "ag_1", agent_name: "A", status: "completed", reply_msg_id: "answer" }];
  act(() => root.render(<MessageFeedback message={message} />));
  act(() => container.querySelector("button")!.click());
  expect(listener.mock.calls[0][0].detail).toEqual({ msgId: "answer", roomId: "rm_1" });
  window.removeEventListener("botcord:jump-to-message", listener);
});
