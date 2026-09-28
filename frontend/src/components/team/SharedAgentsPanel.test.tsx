import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
vi.mock("@/lib/i18n", () => ({ useLanguage: () => "zh" }));
import SharedAgentsPanel from "./SharedAgentsPanel";
import type { SpaceAgent } from "@/lib/team-spaces";

it("lists my Agents and Agents shared with me as separate groups", () => {
  const html = renderToStaticMarkup(
    <SharedAgentsPanel
      spaceId="org-a"
      myAgents={[{ agent_id: "ag_mine", display_name: "My Bot", status: "active" } as SpaceAgent]}
      onOpenRoom={() => {}}
    />
  );
  expect(html).toContain("我的 Agent");
  expect(html).toContain("My Bot");
  expect(html).toContain("共享给我的");
  expect(html).toContain("在组织消息里打开");
});
