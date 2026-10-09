import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
vi.mock("@/lib/i18n", () => ({ useLanguage: () => "zh" }));
vi.mock("next/navigation", () => ({ usePathname: () => "/chats/team" }));
import SharedAgentsPanel from "./SharedAgentsPanel";

it("explains the directory and starts in a loading state", () => {
  const html = renderToStaticMarkup(<SharedAgentsPanel spaceId="org-a" onOpenRoom={() => {}} />);
  expect(html).toContain("组织 Agent 目录");
  expect(html).toContain("在组织消息里打开私聊");
  expect(html).toContain("向所有者申请");
  expect(html).toContain("正在加载");
});
