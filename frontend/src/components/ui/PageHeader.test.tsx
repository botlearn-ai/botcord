// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import PageHeader from "./PageHeader";
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: ReturnType<typeof createRoot>;
function mount(content: React.ReactNode) {
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  act(() => root.render(content)); return host;
}
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });

it("renders an h1 with eyebrow, description and actions", () => {
  const host = mount(<PageHeader eyebrow="Team" title="Team workspace" description="Manage members" actions={<button type="button">Create</button>} />);
  const heading = host.querySelector("h1")!;
  expect(heading.textContent).toBe("Team workspace");
  expect(heading.className).toContain("type-heading-2");
  const eyebrow = host.querySelector("p")!;
  expect(eyebrow.textContent).toBe("Team");
  expect(eyebrow.className).not.toMatch(/uppercase|tracking/);
  expect(host.textContent).toContain("Manage members");
  expect(host.querySelector("button")!.textContent).toBe("Create");
});

it("supports a centered h2 with an icon", () => {
  const host = mount(<PageHeader align="center" level={2} icon={<span data-testid="icon" />} title="Start" />);
  expect(host.querySelector("h1")).toBeNull();
  expect(host.querySelector("h2")!.className).toContain("type-heading-3");
  expect(host.querySelector("header")!.className).toContain("text-center");
  expect(host.querySelector("[data-testid=icon]")).not.toBeNull();
});
