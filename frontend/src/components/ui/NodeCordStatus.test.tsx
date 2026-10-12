// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import NodeCordStatus from "./NodeCordStatus";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

afterEach(() => {
  document.body.innerHTML = "";
});

function setup() {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  return { host, root };
}

it("renders a static mark without animation classes", () => {
  const { host, root } = setup();
  act(() => root.render(<NodeCordStatus state="static" size={32} className="text-text-primary" />));
  const svg = host.querySelector("svg")!;
  expect(svg.getAttribute("aria-label")).toBe("static");
  expect(svg.getAttribute("width")).toBe("32");
  expect(svg.getAttribute("class")).toContain("text-text-primary");
  expect(svg.querySelector("path")!.getAttribute("stroke")).toBe("currentColor");
  expect(svg.querySelector(".fill-brand")).not.toBeNull();
  expect(svg.querySelector('[class*="bc-cord-"]')).toBeNull();
  act(() => root.unmount());
});

it("adds the per-state animation element", () => {
  const { host, root } = setup();
  const expected = {
    sending: ".bc-cord-courier",
    thinking: ".bc-cord-breathe",
    delivered: ".bc-cord-ripple",
    waiting: ".bc-cord-blink",
  } as const;
  for (const [state, selector] of Object.entries(expected)) {
    act(() => root.render(<NodeCordStatus state={state as keyof typeof expected} />));
    expect(host.querySelector(selector)).not.toBeNull();
  }
  act(() => root.render(<NodeCordStatus state="waiting" />));
  expect(host.querySelector(".fill-warning")).not.toBeNull();
  expect(host.querySelector(".fill-brand")).toBeNull();
  act(() => root.unmount());
});

it("draws offline as a grey mark with a hollow signal node", () => {
  const { host, root } = setup();
  act(() => root.render(<NodeCordStatus state="offline" />));
  expect(host.querySelector("g")!.getAttribute("class")).toContain("text-text-tertiary");
  expect(host.querySelector(".fill-surface")).not.toBeNull();
  expect(host.querySelector(".fill-brand")).toBeNull();
  expect(host.querySelector('[class*="bc-cord-"]')).toBeNull();
  act(() => root.unmount());
});
