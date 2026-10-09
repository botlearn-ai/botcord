import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
vi.mock("@/lib/i18n", () => ({ useLanguage: () => "zh" }));
import AgentDefaultPermission from "./AgentDefaultPermission";

it("explains the scope of the default permission", () => {
  const html = renderToStaticMarkup(<AgentDefaultPermission agentId="ag_x" />);
  expect(html).toContain("别人使用这个 Agent 时的默认权限");
  expect(html).toContain("新加的好友、新加入的群和公开这个 Agent；已有的关系不变");
  expect(html).toContain("正在加载");
});
