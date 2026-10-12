// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import Checkbox from "./Checkbox";
import type { CheckboxState } from "./Checkbox";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function mount(checked: CheckboxState, onCheckedChange = vi.fn()) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(<Checkbox checked={checked} onCheckedChange={onCheckedChange} label="Select all" />));
  const input = host.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  return { root, input, onCheckedChange, rerender: (next: CheckboxState) => act(() => root.render(<Checkbox checked={next} onCheckedChange={onCheckedChange} label="Select all" />)) };
}

afterEach(() => { document.body.innerHTML = ""; });

it("renders a native checkbox labelled by its label", () => {
  const { root, input } = mount(false);
  expect(input.closest("label")?.textContent).toContain("Select all");
  expect(input.checked).toBe(false);
  expect(input.indeterminate).toBe(false);
  act(() => root.unmount());
});

it("sets the indeterminate DOM property and reports true when clicked", () => {
  const { root, input, onCheckedChange, rerender } = mount("indeterminate");
  expect(input.indeterminate).toBe(true);
  expect(input.checked).toBe(false);

  act(() => input.click());
  expect(onCheckedChange).toHaveBeenCalledWith(true);
  // Parent kept "indeterminate": the DOM state is restored.
  expect(input.indeterminate).toBe(true);

  rerender(true);
  expect(input.indeterminate).toBe(false);
  expect(input.checked).toBe(true);
  act(() => root.unmount());
});
