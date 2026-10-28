// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import UnreadBadge from "./UnreadBadge";
vi.mock("@/lib/anime", () => ({ animatePop: () => null, cleanupAnime: () => {} }));
let root: Root; let host: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.useFakeTimers();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(() => root.unmount()); host.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });
const render = (count: number) => act(() => root.render(<UnreadBadge count={count} burstOnClear />));
it("removes unread text immediately and cleans up the decorative burst", async () => {
  await render(12); await render(0);
  expect(host.textContent).toBe("");
  expect(host.querySelector("[data-unread-burst]")?.getAttribute("aria-hidden")).toBe("true");
  await act(() => vi.advanceTimersByTime(220)); expect(host.innerHTML).toBe("");
});
it("restores the badge without letting the old animation erase a new message", async () => {
  await render(12); await render(0); await render(1);
  await act(() => vi.advanceTimersByTime(300));
  expect(host.textContent).toBe("1"); expect(host.querySelector("[data-unread-burst]")).toBeNull();
});
it("skips the burst for reduced motion and for initially read rooms", async () => {
  vi.stubGlobal("matchMedia", () => ({ matches: true }));
  await render(0); expect(host.innerHTML).toBe("");
  await render(12); await render(0); expect(host.innerHTML).toBe("");
});
