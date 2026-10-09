import { describe, expect, it, vi } from "vitest";
import { composerPopoverGeometry, shouldSendOnEnter, observeChatViewportResize } from "./mobileChat";

describe("chat keyboard", () => {
  it("keeps Return for newlines on touch keyboards", () => {
    expect(shouldSendOnEnter("Enter", false, false, true)).toBe(false);
  });
  it("retains desktop Enter to send, Shift+Enter and IME composition", () => {
    expect(shouldSendOnEnter("Enter", false, false, false)).toBe(true);
    expect(shouldSendOnEnter("Enter", true, false, false)).toBe(false);
    expect(shouldSendOnEnter("Enter", false, true, false)).toBe(false);
    expect(shouldSendOnEnter("a", false, false, false)).toBe(false);
  });
});
describe("composer popovers", () => {
  it("fits the panel above the composer in a keyboard-reduced viewport", () => {
    const panel = composerPopoverGeometry({ left: 12, top: 210, width: 296 }, { left: 0, top: 44, width: 320, height: 260 }, 296);
    expect(panel.top).toBeLessThan(210);
    expect(panel.top - panel.maxHeight).toBeGreaterThanOrEqual(52);
    expect(panel.left + panel.width).toBeLessThanOrEqual(312);
  });
  it("clamps a right-edge anchor and wide content to the viewport", () => {
    const panel = composerPopoverGeometry({ left: 300, top: 500, width: 400 }, { left: 0, top: 0, width: 320, height: 400 }, 400);
    expect(panel.left).toBe(8);
    expect(panel.width).toBe(304);
    expect(panel.top).toBe(392);
  });
});

it("follows viewport height changes only while reading the latest messages", () => {
  let resize = () => {};
  const disconnect = vi.fn();
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: () => void) { resize = callback; }
    observe() {}
    disconnect = disconnect;
  });
  try {
    const container = { clientHeight: 600 };
    let following = true;
    const follow = vi.fn();
    const cleanup = observeChatViewportResize(container as HTMLElement, () => following, follow);
    resize();
    expect(follow).not.toHaveBeenCalled();
    container.clientHeight = 250;
    resize();
    expect(follow).toHaveBeenCalledTimes(1);
    following = false;
    container.clientHeight = 200;
    resize();
    expect(follow).toHaveBeenCalledTimes(1);
    following = true;
    container.clientHeight = 600;
    resize();
    expect(follow).toHaveBeenCalledTimes(2);
    cleanup();
    expect(disconnect).toHaveBeenCalledOnce();
  } finally {
    vi.unstubAllGlobals();
  }
});
