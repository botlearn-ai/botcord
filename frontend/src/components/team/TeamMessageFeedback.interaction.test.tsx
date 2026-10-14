// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DashboardMessage } from "@/lib/types";
const send = vi.hoisted(() => vi.fn());
const locale = vi.hoisted(() => ({ value: "zh" }));
vi.mock("@/lib/i18n", () => ({ useLanguage: () => locale.value }));
vi.mock("@/lib/room-message-send", () => ({ sendDashboardRoomMessage: send }));
import { MessageFeedback } from "./TeamMessageFeedback";
let container: HTMLDivElement;
let root: Root;
let message: DashboardMessage;
beforeEach(() => {
  vi.useFakeTimers();
  locale.value = "zh";
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
it.each(["zh", "en"])("shows only the shared avatar thinking indicator throughout waiting in %s", (language) => {
  locale.value = language;
  const label = language === "zh" ? "思考中" : "Thinking";
  for (const status of ["waiting", "processing"] as const) {
    message.reply_activity = [{ agent_id: "ag_1", agent_name: "A very long agent name", avatar_url: "/agent-avatars/jellyfish-cyan.svg", status }];
    act(() => root.render(<MessageFeedback message={message} />));
    expect(container.textContent).toBe("");
    expect(container.querySelector('[data-status="thinking"]')).not.toBeNull();
    expect(container.querySelector('[role="status"]')?.getAttribute("aria-label")).toBe(`A very long agent name ${label}`);
    expect(container.querySelectorAll("img")).toHaveLength(1);
    expect(container.querySelector("img")?.alt).toBe("A very long agent name");
    expect(container.querySelector("img")?.getAttribute("src")).toBe("/agent-avatars/jellyfish-cyan.svg");
    act(() => vi.advanceTimersByTime(60000));
    expect(container.textContent).toBe("");
    expect(container.querySelector('[data-status="thinking"]')).not.toBeNull();
    expect(container.querySelector('[role="status"]')?.getAttribute("aria-label")).toBe(`A very long agent name ${label}`);
  }
  act(() => root.render(<MessageFeedback message={{ ...message, reply_activity: [{ ...message.reply_activity![0], status: "completed" }] }} />));
  expect(container.innerHTML).toBe("");
});
it("retries only failed agents while retaining the message payload and quote", async () => {
  message.reply_activity = [{ agent_id: "ag_1", agent_name: "A", status: "completed" }, { agent_id: "ag_2", agent_name: "B", status: "failed" }];
  act(() => root.render(<MessageFeedback message={message} />));
  await act(async () => container.querySelector("button")!.click());
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ mentions: ["ag_2"], payload: message.payload, retry_reply_to: "quote" }));
  expect(container.querySelector("button")).toBeNull();
  expect(container.textContent).toContain("已重新发送");
});

it("hides completed feedback because the reply itself is the result", () => {
  message.reply_activity = [{ agent_id: "ag_1", agent_name: "A", status: "completed", reply_msg_id: "answer" }];
  act(() => root.render(<MessageFeedback message={message} />));
  expect(container.innerHTML).toBe("");
});
