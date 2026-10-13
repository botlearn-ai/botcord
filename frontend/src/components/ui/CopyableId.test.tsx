// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import CopyableId from "./CopyableId";
let container: HTMLDivElement;
let root: Root;
const writeText = vi.fn();
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  writeText.mockReset();
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root.render(<CopyableId value="ag_test" copyLabel="复制 ID" copiedLabel="已复制" copyFailedLabel="复制失败" />));
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.useRealTimers(); });
it("keeps the icon visible and announces success only after clipboard resolves", async () => {
  let resolve!: () => void;
  writeText.mockReturnValue(new Promise<void>(done => { resolve = done; }));
  const button = container.querySelector("button")!;
  expect(button.type).toBe("button");
  expect(button.getAttribute("aria-label")).toBe("复制 ID: ag_test");
  expect(button.querySelector("svg")).not.toBeNull();
  await act(async () => button.click());
  expect(container.querySelector('[role="status"]')!.textContent).toBe("");
  await act(async () => resolve());
  expect(writeText).toHaveBeenCalledWith("ag_test");
  expect(container.querySelector('[role="status"]')!.textContent).toBe("已复制");
  act(() => vi.advanceTimersByTime(1500));
  expect(container.querySelector('[role="status"]')!.textContent).toBe("");
});
it("announces clipboard failure without claiming success", async () => {
  writeText.mockRejectedValue(new Error("denied"));
  await act(async () => container.querySelector("button")!.click());
  expect(container.querySelector('[role="status"]')!.textContent).toBe("复制失败");
});
