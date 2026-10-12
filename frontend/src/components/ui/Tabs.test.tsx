// @vitest-environment jsdom
import React, { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import Tabs from "./Tabs";
import type { TabItem } from "./Tabs";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const ITEMS: TabItem[] = [
  { value: "a", label: "Alpha" },
  { value: "b", label: "Beta", disabled: true },
  { value: "c", label: "Gamma" },
];

function Harness({ onChange }: { onChange?: (v: string) => void }) {
  const [value, setValue] = useState("a");
  return <Tabs ariaLabel="Sections" items={ITEMS} value={value} onValueChange={(v) => { setValue(v); onChange?.(v); }} />;
}

function mount() {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(<Harness />));
  return root;
}

const tabs = () => [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
const press = (el: Element, key: string) =>
  act(() => { el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })); });

afterEach(() => { document.body.innerHTML = ""; });

it("renders a labelled tablist with one selected tab as the only tab stop", () => {
  const root = mount();
  expect(document.querySelector('[role="tablist"]')?.getAttribute("aria-label")).toBe("Sections");
  expect(tabs().map((t) => t.getAttribute("aria-selected"))).toEqual(["true", "false", "false"]);
  expect(tabs().map((t) => t.tabIndex)).toEqual([0, -1, -1]);
  act(() => root.unmount());
});

it("arrow keys move selection and skip disabled tabs, wrapping around", () => {
  const root = mount();
  press(tabs()[0], "ArrowRight");
  expect(tabs()[2].getAttribute("aria-selected")).toBe("true");
  expect(document.activeElement).toBe(tabs()[2]);

  press(tabs()[2], "ArrowRight");
  expect(tabs()[0].getAttribute("aria-selected")).toBe("true");

  press(tabs()[0], "ArrowLeft");
  expect(tabs()[2].getAttribute("aria-selected")).toBe("true");

  press(tabs()[2], "Home");
  expect(tabs()[0].getAttribute("aria-selected")).toBe("true");
  expect(tabs()[1].getAttribute("aria-selected")).toBe("false");
  act(() => root.unmount());
});

it("clicking a disabled tab does nothing", () => {
  const root = mount();
  act(() => tabs()[1].click());
  expect(tabs()[0].getAttribute("aria-selected")).toBe("true");
  act(() => root.unmount());
});
