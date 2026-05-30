import { describe, expect, it } from "vitest";
import { getActionMenuPosition } from "./message-action-menu";

const defaults = {
  menuWidth: 112,
  menuHeight: 128,
  viewportWidth: 1024,
  viewportHeight: 760,
  gap: 6,
  viewportPadding: 8,
};

describe("getActionMenuPosition", () => {
  it("places the action menu above the trigger when the bottom of the viewport is tight", () => {
    const pos = getActionMenuPosition({
      ...defaults,
      anchorRect: { left: 850, right: 874, top: 704, bottom: 728 },
      alignRight: true,
    });

    expect(pos.placement).toBe("above");
    expect(pos.top).toBe(570);
    expect(pos.top + defaults.menuHeight).toBeLessThan(704);
  });

  it("keeps the action menu below the trigger when there is room", () => {
    const pos = getActionMenuPosition({
      ...defaults,
      anchorRect: { left: 220, right: 244, top: 220, bottom: 244 },
      alignRight: false,
    });

    expect(pos).toMatchObject({
      placement: "below",
      left: 220,
      top: 250,
    });
  });

  it("clamps the menu horizontally inside the viewport", () => {
    const pos = getActionMenuPosition({
      ...defaults,
      viewportWidth: 160,
      anchorRect: { left: 130, right: 154, top: 220, bottom: 244 },
      alignRight: false,
    });

    expect(pos.left).toBe(40);
  });
});
