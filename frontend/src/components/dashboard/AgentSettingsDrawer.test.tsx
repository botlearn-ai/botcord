import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("./DashboardOverlayPortal", () => ({
  withDashboardOverlayPortal: (component: unknown) => component,
}));
vi.mock("@/lib/i18n", () => ({ useLanguage: () => "zh" }));
vi.mock("./BotRuntimeCapabilitiesPanel", () => ({ default: () => null }));

import AgentSettingsDrawer from "./AgentSettingsDrawer";

function render(hostingKind: string) {
  return renderToStaticMarkup(
    <AgentSettingsDrawer agentId="ag_copy" displayName="Test Agent" hostingKind={hostingKind} onClose={() => {}} />,
  );
}

describe("Agent settings removal labels", () => {
  it("labels cloud deletion as deletion", () => {
    const html = render("cloud");
    expect(html).toMatch(/>删除<\/button>/);
    expect(html).not.toContain("解除绑定");
  });

  it("labels local removal as unbinding", () => {
    const html = render("local");
    expect(html).toContain("解除绑定");
    expect(html).not.toMatch(/>删除<\/button>/);
  });
});
