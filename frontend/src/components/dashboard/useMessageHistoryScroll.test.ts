// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { observeMessageHistoryScroll } from "./useMessageHistoryScroll";

function touch(node: HTMLElement, type: string, x: number, y: number, count = 1) {
  const event = new Event(type);
  Object.assign(event, { touches: Array.from({ length: count }, () => ({ clientX: x, clientY: y })) });
  node.dispatchEvent(event);
}

it("loads toward the top, never while scrolling down or jumping to latest", () => {
  const node = document.createElement("div");
  node.scrollTop = 200;
  const load = vi.fn();
  const dispose = observeMessageHistoryScroll(node, load);
  node.scrollTop = 90; node.dispatchEvent(new Event("scroll"));
  expect(load).toHaveBeenCalledTimes(1);
  node.scrollTop = 95; node.dispatchEvent(new Event("scroll"));
  node.scrollTop = 800; node.dispatchEvent(new Event("scroll"));
  expect(load).toHaveBeenCalledTimes(1);
  dispose();
});

it("loads once for a downward pull on a short feed and ignores upward swipes", () => {
  const node = document.createElement("div");
  const load = vi.fn();
  const dispose = observeMessageHistoryScroll(node, load);
  touch(node, "touchstart", 100, 200);
  touch(node, "touchmove", 100, 140);
  expect(load).not.toHaveBeenCalled();
  touch(node, "touchstart", 100, 200);
  touch(node, "touchmove", 100, 245);
  touch(node, "touchmove", 100, 280);
  expect(load).toHaveBeenCalledTimes(1);
  dispose();
  touch(node, "touchstart", 100, 200);
  touch(node, "touchmove", 100, 260);
  expect(load).toHaveBeenCalledTimes(1);
});

it("ignores horizontal, multi-touch and cancelled gestures", () => {
  const node = document.createElement("div");
  const load = vi.fn();
  const dispose = observeMessageHistoryScroll(node, load);
  touch(node, "touchstart", 100, 200);
  touch(node, "touchmove", 200, 250);
  touch(node, "touchstart", 100, 200, 2);
  touch(node, "touchmove", 100, 260, 2);
  touch(node, "touchstart", 100, 200);
  node.dispatchEvent(new Event("touchcancel"));
  touch(node, "touchmove", 100, 260);
  expect(load).not.toHaveBeenCalled();
  dispose();
});

it("handles upward wheel input even without overflow", () => {
  const node = document.createElement("div");
  const load = vi.fn();
  const dispose = observeMessageHistoryScroll(node, load);
  node.dispatchEvent(new WheelEvent("wheel", { deltaY: 50 }));
  expect(load).not.toHaveBeenCalled();
  node.dispatchEvent(new WheelEvent("wheel", { deltaY: -50 }));
  expect(load).toHaveBeenCalledTimes(1);
  dispose();
});
