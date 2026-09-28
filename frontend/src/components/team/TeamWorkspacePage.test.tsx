import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import { createTeamSpaceStore, type TeamSnapshot, type TeamSpaceStore } from "@/store/team-space-store";
const route = vi.hoisted(() => ({ query: new URLSearchParams() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => route.query,
}));
vi.mock("@/lib/i18n", () => ({ useLanguage: () => "zh" }));
vi.mock("./TeamSpacesPage", () => ({
  default: ({ section, sharedStore }: { section: string; sharedStore?: TeamSpaceStore }) => (
    <div data-management={section} data-shared={Boolean(sharedStore)}>Management</div>
  ),
}));
vi.mock("./SharedAgentsPanel", () => ({
  default: ({ spaceId }: { spaceId: string }) => <div data-shared-agents={spaceId}>Shared</div>,
}));
import { TeamWorkspace, listTime, previewSender, teamHref, teamView } from "./TeamWorkspacePage";
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
it("passes the page store to every management tab instead of loading a second snapshot", () => {
  const sharedStore = createTeamSpaceStore(true);
  for (const view of ["members", "agents", "settings"]) {
    route.query.set("view", view);
    const html = renderToStaticMarkup(
      <TeamWorkspace snapshot={snapshot} sharedStore={sharedStore} onMembershipChanged={() => {}} />
    );
    expect(html).toContain('data-shared="true"');
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
it("lists Agents shared with the member in their own view", () => {
  const html = renderToStaticMarkup(
    <TeamWorkspace snapshot={snapshot} onMembershipChanged={() => {}} />
  );
  expect(html).toContain('href="/chats/team?space=org-a&amp;view=shared"');
  route.query.set("view", "shared");
  const shared = renderToStaticMarkup(
    <TeamWorkspace snapshot={snapshot} onMembershipChanged={() => {}} />
  );
  expect(shared).toContain('data-shared-agents="org-a"');
  expect(shared).not.toContain("data-management");
  expect(teamView("shared")).toBe("shared");
});
it("keeps the organization in every destination and normalizes unknown views", () => {
  expect(teamView("bad")).toBe("messages");
  expect(teamHref("a/b", "rooms", "c/d")).toBe(
    "/chats/team?space=a%2Fb&view=rooms&conversation=c%2Fd"
  );
  expect(teamHref("other")).toBe("/chats/team?space=other");
});

it("prefixes previews with the sender, or 我 for your own messages", () => {
  expect(previewSender({ last_message_author_name: "Alice", last_message_mine: false }, true)).toBe("Alice: ");
  expect(previewSender({ last_message_author_name: "Danny", last_message_mine: true }, true)).toBe("我: ");
  expect(previewSender({}, false)).toBe("");
});

it("formats list times like a chat app", () => {
  const now = new Date(2026, 8, 28, 17, 42);
  expect(listTime(new Date(2026, 8, 28, 9, 5).toISOString(), true, now)).toBe("09:05");
  expect(listTime(new Date(2026, 8, 27, 22, 0).toISOString(), true, now)).toBe("昨天");
  expect(listTime(new Date(2026, 7, 1, 8, 0).toISOString(), true, now)).toBe("8/1");
});

it("renders a mobile bottom navigation with team sections", () => {
  const html = renderToStaticMarkup(
    <TeamWorkspace snapshot={snapshot} onMembershipChanged={() => {}} />
  );
  const bars = html.match(/aria-label="团队导航"/g) ?? [];
  expect(bars.length).toBe(2); // desktop sidebar + mobile bottom bar
  expect(html).toContain("md:hidden");
  expect(html).toContain('aria-label="组织设置"');
});
