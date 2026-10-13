// @vitest-environment jsdom
import React, { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import SwipeableRow from "./SwipeableRow";
let root: Root;
let host: HTMLDivElement;
const select = vi.fn();
const pin = vi.fn();
function Fixture() {
  const [open, setOpen] = useState(false);
  return <SwipeableRow open={open} onOpenChange={setOpen} label="Actions" actions={[
    { label: "Pin", className: "", onClick: pin },
  ]}><div data-content onClick={select}>Room</div></SwipeableRow>;
}
async function pointer(type: string, x: number, y: number) {
  await act(() => {
    const event = new Event(type, { bubbles: true });
    Object.assign(event, { clientX: x, clientY: y, pointerType: "touch", pointerId: 1, isPrimary: true });
    host.querySelector('[data-content]')!.dispatchEvent(event);
  });
}
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  HTMLElement.prototype.setPointerCapture = vi.fn();
  select.mockClear(); pin.mockClear();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(() => root.render(<Fixture />));
});
afterEach(async () => { await act(() => root.unmount()); host.remove(); });
it("reveals actions on left swipe without opening the room", async () => {
  await pointer("pointerdown", 300, 50); await pointer("pointermove", 210, 52); await pointer("pointerup", 210, 52);
  await act(() => host.querySelector<HTMLElement>('[data-content]')!.click());
  expect(select).not.toHaveBeenCalled();
  // The synthetic click after a swipe must not dismiss the just-opened actions.
  expect(host.querySelector('[data-swipe-open]')?.getAttribute('data-swipe-open')).toBe("true");
});
it("ignores vertical scroll and cancelled gestures", async () => {
  await pointer("pointerdown", 300, 50); await pointer("pointermove", 299, 100); await pointer("pointerup", 210, 150);
  expect(host.querySelector('[data-swipe-open]')?.getAttribute('data-swipe-open')).toBe("false");
  await pointer("pointerdown", 300, 50); await pointer("pointermove", 210, 52); await pointer("pointercancel", 210, 52);
  expect(host.querySelector('[data-swipe-open]')?.getAttribute('data-swipe-open')).toBe("false");
});
it("supports button and keyboard alternatives and closes after an action", async () => {
  await act(() => host.querySelector<HTMLButtonElement>('[aria-label="Actions"]')!.click());
  await act(() => Array.from(host.querySelectorAll("button")).find((node) => node.textContent === "Pin")!.click());
  expect(pin).toHaveBeenCalledTimes(1); expect(select).not.toHaveBeenCalled();
  expect(host.querySelector('[data-swipe-open]')?.getAttribute('data-swipe-open')).toBe("false");
});
