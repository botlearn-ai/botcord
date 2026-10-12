// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import LoadingPreview from "./LoadingPreview";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

it("opens the full-page loader and provides a close action", () => {
  const host = document.createElement("div");
  const root = createRoot(host);
  act(() => root.render(<LoadingPreview />));
  const dialog = host.querySelector("dialog")!;
  dialog.showModal = vi.fn(() => dialog.setAttribute("open", ""));
  dialog.close = vi.fn(() => dialog.removeAttribute("open"));
  expect(dialog.hasAttribute("open")).toBe(false);
  act(() => host.querySelector("button")!.click());
  expect(dialog.hasAttribute("open")).toBe(true);
  expect(dialog.querySelector('[role="status"]')?.getAttribute("aria-label")).toBe("正在加载 BotCord");
  expect(dialog.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
  act(() => dialog.querySelector("button")!.click());
  expect(dialog.hasAttribute("open")).toBe(false);
  act(() => root.unmount());
});
