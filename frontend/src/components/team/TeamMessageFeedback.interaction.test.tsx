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
  locale.value = "zh";
  send.mockReset().mockResolvedValue(undefined);
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  message = { hub_msg_id: "h_1", msg_id: "m_1", room_id: "rm_1", sender_kind: "human", is_mine: true,
    payload: { text: "help", attachments: [{ url: "/file" }] }, retry_reply_to: "quote", created_at: new Date().toISOString() } as unknown as DashboardMessage;
});
afterEach(() => { act(() => root.unmount()); container.remove(); });
it.each(["zh", "en"])("has no visible status text and distinguishes waiting, thinking and replying in %s", (language) => {
  locale.value = language;
  for (const state of ["waiting", "processing", "replying", "completed"] as const) {
    message.reply_activity = [{ agent_id: "a", agent_name: "Long name", status: "processing", response_state: state }];
    act(() => root.render(<MessageFeedback message={message} />));
    expect(container.textContent).toBe("");
    expect(container.querySelector('[data-response-state]')?.getAttribute("data-response-state")).toBe(state);
    expect(!!container.querySelector('[data-status="thinking"]')).toBe(state === "processing");
    expect(!!container.querySelector(".bc-avatar-orbit")).toBe(state === "replying");
  }
});
it("retries only failed agents while retaining the payload and quote", async () => {
  message.reply_activity = [{ agent_id: "ag_1", agent_name: "A", status: "completed" }, { agent_id: "ag_2", agent_name: "B", status: "failed" }];
  act(() => root.render(<MessageFeedback message={message} />));
  act(() => container.querySelector<HTMLButtonElement>('[role="toolbar"] button')!.click());
  await act(async () => (document.querySelector("[data-response-retry]") as HTMLButtonElement).click());
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ mentions: ["ag_2"], payload: message.payload, retry_reply_to: "quote" }));
  expect(document.querySelector("[data-response-retry]")).toBeNull();
  expect(document.body.textContent).toContain("已重新发送");
});
