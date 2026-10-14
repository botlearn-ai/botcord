// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import AgentReactionStrip from "./AgentReactionStrip";
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root;
afterEach(() => { if (root) act(() => root.unmount()); document.body.innerHTML = ""; vi.unstubAllGlobals(); });
it("folds after eight, retains all identities for selection and supports arrow keys", () => {
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  const select = vi.fn();
  const items = Array.from({ length: 12 }, (_, i) => ({ id: `${i}`, name: `Agent ${i}`, label: `Agent ${i}`, state: "completed" as const }));
  act(() => root.render(<AgentReactionStrip items={items} label="All" moreLabel={(n) => `More ${n}`} onSelect={select} />));
  const toolbar = host.querySelector('[role="toolbar"]')!;
  expect(toolbar.querySelectorAll("button")).toHaveLength(9);
  expect(toolbar.textContent).toBe("+4");
  const buttons = toolbar.querySelectorAll("button");
  act(() => buttons[0].focus());
  act(() => buttons[0].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
  expect(document.activeElement).toBe(buttons[1]);
  act(() => buttons[8].click()); expect(select).toHaveBeenLastCalledWith(null, buttons[8]);
  act(() => buttons[1].click()); expect(select).toHaveBeenLastCalledWith("1", buttons[1]);
});
it("reduces visible avatars to fit a narrow message", () => {
  let resize: ResizeObserverCallback;
  vi.stubGlobal("ResizeObserver", class { constructor(fn: ResizeObserverCallback) { resize = fn; } observe() {} disconnect() {} });
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  const items = Array.from({ length: 12 }, (_, i) => ({ id: `${i}`, name: `${i}`, label: `${i}`, state: i === 11 ? "failed" as const : "completed" as const }));
  act(() => root.render(<AgentReactionStrip items={items} label="All" moreLabel={String} onSelect={() => {}} />));
  act(() => resize!([{ contentRect: { width: 180 } } as ResizeObserverEntry], {} as ResizeObserver));
  expect(host.querySelector('[role="toolbar"]')?.textContent).toBe("+8");
  expect(host.querySelector('[role="toolbar"] .bg-warning')).not.toBeNull();
});
