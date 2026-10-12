// @vitest-environment jsdom
import React, { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import Switch from "./Switch";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function Harness({ disabled }: { disabled?: boolean }) {
  const [on, setOn] = useState(false);
  return <Switch checked={on} onCheckedChange={setOn} label="Notifications" disabled={disabled} />;
}

function mount(node: React.ReactNode) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(node));
  return root;
}

afterEach(() => { document.body.innerHTML = ""; });

it("exposes role=switch and toggles aria-checked on click and via its label", () => {
  const root = mount(<Harness />);
  const sw = document.querySelector<HTMLButtonElement>('[role="switch"]')!;
  expect(sw.getAttribute("aria-checked")).toBe("false");
  expect(sw.className).toContain("bg-border-strong");

  act(() => sw.click());
  expect(sw.getAttribute("aria-checked")).toBe("true");
  expect(sw.className).toContain("bg-accent");

  const text = [...document.querySelectorAll("span")].find((s) => s.textContent === "Notifications")!;
  act(() => text.click());
  expect(sw.getAttribute("aria-checked")).toBe("false");
  act(() => root.unmount());
});

it("does not toggle when disabled", () => {
  const onChange = vi.fn();
  const root = mount(<Switch checked={false} onCheckedChange={onChange} disabled aria-label="x" />);
  act(() => document.querySelector<HTMLButtonElement>('[role="switch"]')!.click());
  expect(onChange).not.toHaveBeenCalled();
  act(() => root.unmount());
});
