// @vitest-environment jsdom
import React, { act, createRef } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import MessageActionPopover from "./MessageActionPopover";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
afterEach(() => vi.unstubAllGlobals());

it("positions above the message, navigates actions and dismisses without triggering disabled actions", async () => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  const host = document.createElement("div");
  document.body.append(host);
  const anchor = document.createElement("button");
  host.append(anchor);
  anchor.getBoundingClientRect = () => ({ left: 210, right: 310, top: 400, bottom: 460, width: 100, height: 60 } as DOMRect);
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 320 });
  const anchorRef = createRef<HTMLButtonElement>();
  anchorRef.current = anchor;
  const container = document.createElement("div");
  host.append(container);
  const root = createRoot(container);
  const close = vi.fn();
  const select = vi.fn();
  try {
    await act(() => root.render(<MessageActionPopover anchorRef={anchorRef} label="消息操作" onClose={close} actions={Array.from({ length: 7 }, (_, i) => ({ id: String(i), label: `操作${i}`, icon: <span />, onSelect: select, disabled: i === 1 }))} />));
    const menu = document.querySelector<HTMLElement>('[role="menu"]')!;
    const buttons = menu.querySelectorAll<HTMLButtonElement>("button");
    expect(parseFloat(menu.style.left)).toBeGreaterThanOrEqual(12);
    expect(parseFloat(menu.style.left) + parseFloat(menu.style.width)).toBeLessThanOrEqual(308);
    expect(parseFloat(menu.style.top)).toBeLessThan(400);
    expect(menu.querySelector(".grid")?.getAttribute("style")).toContain("repeat(4");
    expect(document.activeElement).toBe(buttons[0]);
    anchor.getBoundingClientRect = () => ({ left: 12, right: 112, top: 20, bottom: 80, width: 100, height: 60 } as DOMRect);
    await act(() => window.dispatchEvent(new Event("resize")));
    expect(parseFloat(menu.style.top)).toBeGreaterThanOrEqual(90);
    await act(() => buttons[0].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
    expect(document.activeElement).toBe(buttons[2]);
    await act(() => buttons[1].click());
    expect(select).not.toHaveBeenCalled();
    await act(() => buttons[2].click());
    expect(select).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    await act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(close).toHaveBeenCalledTimes(2);
    await act(() => document.body.dispatchEvent(new Event("pointerdown", { bubbles: true })));
    expect(close).toHaveBeenCalledTimes(3);
  } finally { await act(() => root.unmount()); host.remove(); }
});
