// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import EmptyState from "./EmptyState";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

afterEach(() => {
  document.body.innerHTML = "";
});

function setup() {
  const host = document.createElement("div");
  document.body.append(host);
  return { host, root: createRoot(host) };
}

it("renders icon, title, description and action", () => {
  const { host, root } = setup();
  act(() => root.render(
    <EmptyState
      icon={<svg data-testid="icon" />}
      title="No agents yet"
      description="Create an agent to start."
      action={<button type="button">Create agent</button>}
      className="extra"
    />,
  ));
  const state = host.firstElementChild!;
  expect(state.className).toContain("text-center");
  expect(state.className).toContain("extra");
  expect(state.className).not.toContain("border-dashed");
  expect(host.querySelector('[data-testid="icon"]')!.parentElement!.getAttribute("aria-hidden")).toBe("true");
  expect(host.textContent).toContain("No agents yet");
  expect(host.textContent).toContain("Create an agent to start.");
  expect(host.querySelector("button")!.textContent).toBe("Create agent");
  act(() => root.unmount());
});

it("supports compact and bordered layouts with only a title", () => {
  const { host, root } = setup();
  act(() => root.render(<EmptyState compact bordered title="Nothing here" />));
  const state = host.firstElementChild!;
  expect(state.className).toContain("border-dashed");
  expect(state.className).toContain("rounded-xl");
  expect(state.className).toContain("py-6");
  expect(host.querySelector('[aria-hidden="true"]')).toBeNull();
  expect(host.querySelectorAll("p")).toHaveLength(1);
  act(() => root.unmount());
});
