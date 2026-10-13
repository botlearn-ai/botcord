// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import Chip from "./Chip";
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: ReturnType<typeof createRoot>;
function mount(content: React.ReactNode) {
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  act(() => root.render(content)); return host;
}
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = ""; });

it("renders as a list item with icon and content", () => {
  const host = mount(<ul><Chip as="li" icon={<svg />} align="start">Atlas</Chip></ul>);
  const chip = host.querySelector("li")!;
  expect(chip.textContent).toBe("Atlas");
  expect(chip.className).toContain("items-start");
  expect(chip.querySelector("button")).toBeNull();
});

it("calls onRemove and disables the action while removing", () => {
  const onRemove = vi.fn();
  const host = mount(<Chip onRemove={onRemove} removeLabel="Remove rule">Alice: always</Chip>);
  const button = host.querySelector("button")!;
  expect(button.getAttribute("aria-label")).toBe("Remove rule");
  act(() => button.click());
  expect(onRemove).toHaveBeenCalledTimes(1);
  act(() => root.render(<Chip onRemove={onRemove} removeLabel="Remove rule" removing>Alice: always</Chip>));
  expect(host.querySelector("button")!.disabled).toBe(true);
});
