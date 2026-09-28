import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
vi.mock("@/lib/i18n", () => ({ useLanguage: () => "zh" }));
import AgentAccessGrants from "./AgentAccessGrants";
import type { SpaceUser } from "@/lib/team-spaces";

const users = [
  { user_id: "me", display_name: "Owner", status: "active" },
  { user_id: "bob", display_name: "Bob", status: "active" },
  { user_id: "gone", display_name: "Gone", status: "removed" },
] as SpaceUser[];

it("offers only other active members, both roles and every duration", () => {
  const html = renderToStaticMarkup(
    <AgentAccessGrants spaceId="org" agentId="ag_x" agentName="Helper" users={users} userId="me" />
  );
  expect(html).toContain(">Bob</option>");
  expect(html).not.toContain(">Owner</option>");
  expect(html).not.toContain(">Gone</option>");
  expect(html).toContain("咨询者（只读：提问、读代码）");
  expect(html).toContain("协作者（可在独立副本改代码）");
  for (const label of ["不限", "1 天", "7 天", "30 天"]) expect(html).toContain(label);
  // Collaborator-only fields stay hidden for the default consultant role.
  expect(html).not.toContain("项目仓库路径");
  expect(html).toContain("正在加载授权");
});
