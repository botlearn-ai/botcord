import { describe, expect, it } from "vitest";
import { getDashboardOverlayStackIndex } from "./DashboardOverlayPortal";

describe("getDashboardOverlayStackIndex", () => {
  it("keeps a later overlay above an earlier overlay in the same layer", () => {
    expect(getDashboardOverlayStackIndex("modal", 2)).toBeGreaterThan(
      getDashboardOverlayStackIndex("modal", 1),
    );
  });

  it("keeps nested and critical overlays above normal modals", () => {
    const newestModal = getDashboardOverlayStackIndex("modal", 99_999);

    expect(getDashboardOverlayStackIndex("nested", 1)).toBeGreaterThan(newestModal);
    expect(getDashboardOverlayStackIndex("critical", 1)).toBeGreaterThan(
      getDashboardOverlayStackIndex("nested", 99_999),
    );
  });
});
