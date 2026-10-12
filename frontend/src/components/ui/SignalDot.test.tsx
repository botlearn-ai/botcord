// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import SignalDot from "./SignalDot";
import type { AgentSignal } from "./SignalDot";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function render(node: React.ReactNode) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(node));
  return { host, root };
}

afterEach(() => {
  document.body.innerHTML = "";
});

it("labels every status with its English name and maps colours", () => {
  const cases: [AgentSignal, string][] = [
    ["idle", "bg-text-tertiary"],
    ["online", "bg-brand"],
    ["thinking", "bg-brand"],
    ["replying", "bg-brand"],
    ["waiting", "bg-warning"],
    ["done", "bg-success"],
    ["offline", "border-text-tertiary"],
  ];
  for (const [status, colour] of cases) {
    const { host, root } = render(<SignalDot status={status} />);
    const dot = host.querySelector('[role="img"]')!;
    expect(dot.getAttribute("aria-label")).toBe(status);
    expect(dot.className).toContain(colour);
    act(() => root.unmount());
  }
});

it("animates thinking and waiting, applies size and className", () => {
  const { host, root } = render(<SignalDot status="thinking" size="md" className="extra" />);
  const dot = host.querySelector('[role="img"]')!;
  expect(dot.className).toContain("bc-signal-breathe");
  expect(dot.className).toContain("h-3 w-3");
  expect(dot.className).toContain("extra");

  act(() => root.render(<SignalDot status="waiting" size="xs" />));
  const ring = host.querySelector(".bc-signal-blink");
  expect(ring?.getAttribute("aria-hidden")).toBe("true");
  expect(host.querySelector('[role="img"]')!.className).toContain("h-2 w-2");

  act(() => root.render(<SignalDot status="idle" />));
  expect(host.querySelector(".bc-signal-blink")).toBeNull();
  expect(host.querySelector('[role="img"]')!.className).not.toContain("bc-signal-breathe");
  act(() => root.unmount());
});
