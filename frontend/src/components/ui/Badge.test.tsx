// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import Badge from "./Badge";
import type { BadgeTone } from "./Badge";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

afterEach(() => {
  document.body.innerHTML = "";
});

function setup() {
  const host = document.createElement("div");
  document.body.append(host);
  return { host, root: createRoot(host) };
}

it("maps soft tones to semantic colour classes", () => {
  const { host, root } = setup();
  const cases: [BadgeTone, string, string][] = [
    ["neutral", "bg-surface-sunken", "text-text-secondary"],
    ["accent", "bg-accent-soft", "text-accent-text"],
    ["success", "bg-success-soft", "text-success"],
    ["warning", "bg-warning-soft", "text-warning"],
    ["danger", "bg-danger-soft", "text-danger"],
  ];
  for (const [tone, bg, text] of cases) {
    act(() => root.render(<Badge tone={tone}>{tone}</Badge>));
    const badge = host.firstElementChild!;
    expect(badge.className).toContain(bg);
    expect(badge.className).toContain(text);
    expect(badge.textContent).toBe(tone);
  }
  act(() => root.unmount());
});

it("supports outline, size, dot, icon and passthrough props", () => {
  const { host, root } = setup();
  act(() => root.render(
    <Badge tone="danger" variant="outline" size="md" dot icon={<svg data-testid="icon" />} className="extra" title="Failed">
      Failed
    </Badge>,
  ));
  const badge = host.firstElementChild!;
  expect(badge.className).toContain("border-danger/50");
  expect(badge.className).not.toContain("bg-danger-soft");
  expect(badge.className).toContain("h-6");
  expect(badge.className).toContain("extra");
  expect(badge.getAttribute("title")).toBe("Failed");
  expect(badge.querySelector(".bg-current")?.getAttribute("aria-hidden")).toBe("true");
  expect(badge.querySelector('[data-testid="icon"]')).not.toBeNull();
  act(() => root.unmount());
});
