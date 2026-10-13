// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import PresenceIndicator from "./PresenceIndicator";
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: ReturnType<typeof createRoot>;
function mount(content: React.ReactNode) {
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  act(() => root.render(content)); return host;
}
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });

it("maps presence to static semantic colours", () => {
  const host = mount(<><PresenceIndicator status="online" /><PresenceIndicator status="busy" /><PresenceIndicator status="offline" /></>);
  const [online, busy, offline] = Array.from(host.children);
  expect(online.className).toContain("bg-accent");
  expect(busy.className).toContain("bg-warning");
  expect(offline.className).toContain("bg-text-tertiary");
  for (const dot of [online, busy, offline]) {
    expect(dot.className).not.toMatch(/animate-|bc-signal/);
    expect(dot.getAttribute("aria-hidden")).toBe("true");
  }
});

it("exposes an accessible name, overlay position and falls back for unknown status", () => {
  const host = mount(<PresenceIndicator status={"ghost" as never} label="Offline" overlay size="lg" />);
  const dot = host.firstElementChild!;
  expect(dot.getAttribute("role")).toBe("img");
  expect(dot.getAttribute("aria-label")).toBe("Offline");
  expect(dot.className).toContain("absolute");
  expect(dot.className).toContain("ring-2");
  expect(dot.className).toContain("bg-text-tertiary");
});
