// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { RoomReplyActivity } from "@/lib/types";
vi.mock("@/lib/i18n", () => ({ useLanguage: () => "zh" }));
import AgentMessageReactions from "./AgentMessageReactions";
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root;
afterEach(() => { if (root) act(() => root.unmount()); document.body.innerHTML = ""; });
it("opens details, updates them on polling, hides private reasons, and restores focus on Escape", () => {
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  let activity: RoomReplyActivity[] = [{ agent_id: "a", agent_name: "Atlas", status: "processing", response_state: "processing", basis: "run" }];
  const render = () => act(() => root.render(<AgentMessageReactions activity={activity} messageId="m" />));
  render();
  const trigger = host.querySelector<HTMLButtonElement>('[role="toolbar"] button')!;
  act(() => { trigger.focus(); trigger.click(); });
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain("思考中");
  activity = [{ ...activity[0], response_state: "interrupted", derived: true, reason: "lease_expired" }]; render();
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain("系统推断");
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain("执行租约超时");
  activity = [{ ...activity[0], response_state: "unknown", reason: "private secret" }]; render();
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain("不代表被忽略");
  expect(document.body.textContent).not.toContain("private secret");
  act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.activeElement).toBe(trigger);
});
