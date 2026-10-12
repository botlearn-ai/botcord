// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import Menu, { MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from "./Menu";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

beforeAll(() => {
  // Radix Popper measures the trigger; jsdom has no ResizeObserver.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

afterEach(() => { document.body.innerHTML = ""; });

it("renders label, items, separator and danger styling when open", () => {
  const onDelete = vi.fn();
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(
    <Menu defaultOpen modal={false}>
      <MenuTrigger asChild><button type="button">Open</button></MenuTrigger>
      <MenuContent>
        <MenuLabel>Agent</MenuLabel>
        <MenuItem icon={<svg data-testid="icon" />}>Rename</MenuItem>
        <MenuItem disabled>Archive</MenuItem>
        <MenuSeparator />
        <MenuItem danger onSelect={onDelete}>Delete</MenuItem>
      </MenuContent>
    </Menu>,
  ));

  const menu = document.querySelector('[role="menu"]')!;
  expect(menu).not.toBeNull();
  expect(menu.className).toContain("bg-surface-raised");
  expect(menu.className).toContain("rounded-xl");
  const items = [...menu.querySelectorAll('[role="menuitem"]')];
  expect(items.map((i) => i.textContent)).toEqual(["Rename", "Archive", "Delete"]);
  expect(items[1].getAttribute("aria-disabled")).toBe("true");
  expect(items[2].className).toContain("text-danger");
  expect(items[0].className).not.toContain("text-danger");
  expect(items[0].querySelector("[aria-hidden]")).not.toBeNull();
  expect(menu.querySelector('[role="separator"]')).not.toBeNull();

  act(() => (items[2] as HTMLElement).click());
  expect(onDelete).toHaveBeenCalledOnce();
  act(() => root.unmount());
});
