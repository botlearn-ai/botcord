import { describe, expect, it } from "vitest";
import { composerPopoverGeometry, shouldSendOnEnter } from "./mobileChat";

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
