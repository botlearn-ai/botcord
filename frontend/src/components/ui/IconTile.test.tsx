// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import IconTile from "./IconTile";
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: ReturnType<typeof createRoot>;
function mount(content: React.ReactNode) {
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  act(() => root.render(content)); return host;
}
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });

it("renders a decorative tile with tone and size classes", () => {
  const host = mount(<><IconTile><svg /></IconTile><IconTile tone="neutral" size="lg"><svg /></IconTile></>);
  const [accent, neutral] = Array.from(host.children);
  expect(accent.getAttribute("aria-hidden")).toBe("true");
  expect(accent.className).toContain("bg-accent-soft");
  expect(accent.className).toContain("h-11");
  expect(neutral.className).toContain("bg-surface-sunken");
  expect(neutral.className).toContain("h-16");
});
