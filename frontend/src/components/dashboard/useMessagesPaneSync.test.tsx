// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sync: vi.fn(), pollNewMessages: vi.fn(),
}));
vi.mock("@/store/useDashboardChatStore", () => ({ useDashboardChatStore: { getState: () => mocks } }));
vi.mock("@/store/useConversationDirectoryStore", () => ({ useConversationDirectoryStore: { getState: () => mocks } }));
vi.mock("@/store/useDashboardUIStore", () => ({ useDashboardUIStore: { getState: () => ({ openedRoomId: "rm_1", messagesPane: "room" }) } }));
import { useMessagesPaneSync } from "./useMessagesPaneSync";
function Harness({ enabled }: { enabled: boolean }) { useMessagesPaneSync(enabled, "token"); return null; }
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  root = createRoot(document.createElement("div"));
});
afterEach(async () => { await act(async () => root.unmount()); vi.useRealTimers(); });
it("refreshes every room source immediately on entry and re-entry, even within the polling interval", async () => {
  await act(async () => root.render(<Harness enabled={false} />));
  expect(mocks.sync).not.toHaveBeenCalled();
  await act(async () => root.render(<Harness enabled />));
  for (const fn of Object.values(mocks)) expect(fn).toHaveBeenCalledTimes(1);
  await act(async () => root.render(<Harness enabled={false} />));
  await act(async () => root.render(<Harness enabled />));
  for (const fn of Object.values(mocks)) expect(fn).toHaveBeenCalledTimes(2);
});
it("polls messages every 5 seconds, directories every 30 seconds, and refreshes on focus", async () => {
  await act(async () => root.render(<Harness enabled />));
  await act(async () => vi.advanceTimersByTimeAsync(5_000));
  expect(mocks.pollNewMessages).toHaveBeenCalledTimes(2);
  expect(mocks.sync).toHaveBeenCalledTimes(1);
  await act(async () => vi.advanceTimersByTimeAsync(25_000));
  expect(mocks.sync).toHaveBeenCalledTimes(2);
  await act(async () => window.dispatchEvent(new Event("focus")));
  expect(mocks.sync).toHaveBeenCalledTimes(3);
  await act(async () => root.render(<Harness enabled={false} />));
  await act(async () => vi.advanceTimersByTimeAsync(30_000));
  expect(mocks.sync).toHaveBeenCalledTimes(3);
});
