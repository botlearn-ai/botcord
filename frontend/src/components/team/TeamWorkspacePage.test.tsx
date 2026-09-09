import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import type { TeamSnapshot } from "@/store/team-space-store";
const route = vi.hoisted(() => ({ query: new URLSearchParams() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => route.query,
}));
vi.mock("@/lib/i18n", () => ({ useLanguage: () => "zh" }));
vi.mock("./TeamSpacesPage", () => ({
  default: ({ section }: { section: string }) => (
    <div data-management={section}>Management</div>
  ),
}));
import { TeamWorkspace, teamHref, teamView } from "./TeamWorkspacePage";
const snapshot = {
  selected: {
    id: "org-a",
    name: "Ouraca",
    kind: "organization",
    status: "active",
    roles: ["owner"],
    membership: { status: "active" },
    organization_messaging_available: true,
  },
  spaces: [
    {
      id: "org-a",
      name: "Ouraca",
      kind: "organization",
      membership: { status: "active" },
    },
  ],
  user: { id: "me", display_name: "Test owner", agents: [] },
  members: { users: [], agents: [] },
} as unknown as TeamSnapshot;
beforeEach(() => {
  route.query = new URLSearchParams("space=org-a");
});
it("opens a messages workspace rather than management forms", () => {
  const html = renderToStaticMarkup(
    <TeamWorkspace snapshot={snapshot} onMembershipChanged={() => {}} />
  );
  expect(html).toContain('aria-label="团队导航"');
  expect(html).toContain('aria-label="会话列表"');
  expect(html).toContain("创建房间");
  expect(html).not.toContain("data-management");
  expect(html).not.toContain("hu_");
  expect(html).not.toContain("管理员访问组织私聊");
});
it("keeps members, agents and settings in separate navigable views", () => {
  for (const view of ["members", "agents", "settings"]) {
    route.query.set("view", view);
    const html = renderToStaticMarkup(
      <TeamWorkspace snapshot={snapshot} onMembershipChanged={() => {}} />
    );
    expect(html).toContain(`data-management="${view}"`);
    expect(html).toContain("返回消息");
    expect(html).not.toContain('aria-label="会话列表"');
  }
});
it("does not enable conversation creation against an older Hub", () => {
  const html = renderToStaticMarkup(
    <TeamWorkspace
      snapshot={{
        ...snapshot,
        selected: {
          ...snapshot.selected,
          organization_messaging_available: false,
        },
      }}
      onMembershipChanged={() => {}}
    />
  );
  expect(html).toContain("团队消息服务尚未开放");
  expect(html.match(/<button[^>]*aria-label="发起私聊"[^>]*>/)?.[0]).toContain(
    'disabled=""'
  );
});
it("keeps the organization in every destination and normalizes unknown views", () => {
  expect(teamView("bad")).toBe("messages");
  expect(teamHref("a/b", "rooms", "c/d")).toBe(
    "/chats/team?space=a%2Fb&view=rooms&conversation=c%2Fd"
  );
  expect(teamHref("other")).toBe("/chats/team?space=other");
});
