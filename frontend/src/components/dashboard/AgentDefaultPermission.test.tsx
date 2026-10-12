import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
vi.mock("@/lib/i18n", () => ({ useLanguage: () => "zh" }));
import AgentDefaultPermission from "./AgentDefaultPermission";

it("explains the scope of the default permission", () => {
  const html = renderToStaticMarkup(<AgentDefaultPermission agentId="ag_x" />);
  expect(html).toContain("默认权限");
  expect(html).toContain("设置他人使用时能做什么。适用于之后新增的好友和群聊。也用于公开此 Agent。已有关系的权限不变。");
  expect(html).toContain("正在加载");
});
