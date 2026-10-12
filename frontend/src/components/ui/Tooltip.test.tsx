// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, expect, it } from "vitest";
import Tooltip from "./Tooltip";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

afterEach(() => { document.body.innerHTML = ""; });

function mount(node: React.ReactNode) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(node));
  return { host, root };
}

it("opens on keyboard focus and describes the trigger", () => {
  const { host, root } = mount(<Tooltip content="Copy ID"><button type="button">copy</button></Tooltip>);
  const trigger = host.querySelector("button")!;
  act(() => trigger.focus());
  const tip = document.querySelector('[role="tooltip"]');
  expect(tip?.textContent).toBe("Copy ID");
  expect(trigger.getAttribute("aria-describedby")).toBe(tip?.id);
  const bubble = document.querySelector("[data-side]")!;
  expect(bubble.className).toContain("bg-text-primary");
  expect(bubble.className).toContain("text-bg");
  act(() => root.unmount());
});

it("renders only the trigger when content is empty", () => {
  const { host, root } = mount(<Tooltip content=""><button type="button">x</button></Tooltip>);
  act(() => host.querySelector("button")!.focus());
  expect(document.querySelector('[role="tooltip"]')).toBeNull();
  act(() => root.unmount());
});
