import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import MessageHistoryControl, { AUTO_HISTORY_MEDIA, canAutoLoadHistory } from "./MessageHistoryControl";

afterEach(() => vi.unstubAllGlobals());

it("never requests scroll pagination without a desktop fine-pointer viewport", () => {
  vi.stubGlobal("window", { matchMedia: vi.fn(() => ({ matches: false })) });
  expect(canAutoLoadHistory()).toBe(false);
  expect(window.matchMedia).toHaveBeenCalledWith(AUTO_HISTORY_MEDIA);
});

it("preserves automatic history pagination for desktop mouse input", () => {
  vi.stubGlobal("window", { matchMedia: vi.fn(() => ({ matches: true })) });
  expect(canAutoLoadHistory()).toBe(true);
});

it("is safe during server rendering and provides an accessible explicit action", () => {
  vi.stubGlobal("window", undefined);
  expect(canAutoLoadHistory()).toBe(false);
  const html = renderToStaticMarkup(<MessageHistoryControl onLoad={() => {}} loadLabel="加载更早消息" scrollLabel="向上滚动" />);
  expect(html).toContain('type="button"');
  expect(html).toContain("加载更早消息");
  expect(html).toContain("message-history-scroll");
});
