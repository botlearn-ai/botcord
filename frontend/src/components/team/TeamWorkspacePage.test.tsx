import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import { createTeamSpaceStore, type TeamSnapshot, type TeamSpaceStore } from "@/store/team-space-store";
const route = vi.hoisted(() => ({ query: new URLSearchParams() }));
const access = vi.hoisted(() => ({ toDecide: [] as { id: string; agent_id: string }[] }));
vi.mock("@/store/useTeamAccessStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/store/useTeamAccessStore")>()),
  useToDecide: () => access.toDecide,
}));
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
vi.mock("./TeamAgentsPage", () => ({
  default: ({ snapshot }: { snapshot: TeamSnapshot }) => (
    <div data-agents-page={snapshot.selected.id}>Agents</div>
  ),
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
  for (const view of ["members", "settings"]) {
    route.query.set("view", view);
    const html = renderToStaticMarkup(
      <TeamWorkspace snapshot={snapshot} onMembershipChanged={() => {}} />
    );
    expect(html).toContain(`data-management="${view}"`);
    expect(html).toContain("返回消息");
    expect(html).not.toContain('aria-label="会话列表"');
  }
  route.query.set("view", "agents");
  const agents = renderToStaticMarkup(
    <TeamWorkspace snapshot={snapshot} onMembershipChanged={() => {}} />
  );
  expect(agents).toContain('data-agents-page="org-a"');
  // The Agent page has its own header: no duplicated title bar.
  expect(agents).not.toContain("data-management");
  expect(agents).not.toContain("组织 Agent");
  expect(agents).not.toContain('aria-label="会话列表"');
});
it("passes the page store to every management tab instead of loading a second snapshot", () => {
  const sharedStore = createTeamSpaceStore(true);
  for (const view of ["members", "settings"]) {
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
it("has one Agent entry and sends old directory links to the Agent page", () => {
  const html = renderToStaticMarkup(
    <TeamWorkspace snapshot={snapshot} onMembershipChanged={() => {}} />
  );
  expect(html).not.toContain("view=shared");
  expect(html).not.toContain("Agent 目录");
  expect(html.match(/href="\/chats\/team\?space=org-a&amp;view=agents"/g)).toHaveLength(2);
  route.query.set("view", "shared");
  const shared = renderToStaticMarkup(
    <TeamWorkspace snapshot={snapshot} onMembershipChanged={() => {}} />
  );
  expect(shared).toContain('data-agents-page="org-a"');
  expect(teamView("shared")).toBe("agents");
});
it("badges the Agent entry only with requests that need my action", () => {
  const withAgents = {
    ...snapshot,
    members: {
      users: [],
      agents: [
        { agent_id: "ag_1", status: "active" },
        { agent_id: "ag_2", status: "active" },
        { agent_id: "ag_3", status: "active" },
      ],
    },
  } as unknown as TeamSnapshot;
  access.toDecide = [];
  const quiet = renderToStaticMarkup(
    <TeamWorkspace snapshot={withAgents} onMembershipChanged={() => {}} />
  );
  const agentLink = (html: string) =>
    html.match(/<a[^>]*view=agents"[^>]*>[\s\S]*?<\/a>/)?.[0] ?? "";
  // No plain Agent count next to the label.
  expect(agentLink(quiet)).not.toContain(">3<");
  expect(agentLink(quiet)).not.toContain("权限申请待处理");
  access.toDecide = [{ id: "r1", agent_id: "ag_1" }];
  const busy = renderToStaticMarkup(
    <TeamWorkspace snapshot={withAgents} onMembershipChanged={() => {}} />
  );
  expect(agentLink(busy)).toContain('aria-label="1 个权限申请待处理"');
  access.toDecide = [];
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

import { TeamRoomRow } from "./TeamWorkspacePage";
import TeamConversationDialog from "./TeamConversationDialog";
import TeamRoomMembersDialog from "./TeamRoomMembersDialog";
import type { OrgRoom } from "@/lib/org-rooms";
import type { SpaceAgent, TeamSpace } from "@/lib/team-spaces";

const orgRoom = (overrides: Partial<OrgRoom> = {}): OrgRoom => ({
  room_id: "rm_1",
  name: "Launch",
  member_count: 3,
  my_role: "member",
  last_message_preview: "ship it",
  last_message_at: new Date().toISOString(),
  last_sender_name: "Alice",
  unread_count: 3,
  has_unread: true,
  space_id: "org-a",
  space_kind: "room",
  space_visibility: "organization",
  joined: true,
  participants: [],
  ...overrides,
});
const row = (room: OrgRoom, unread = room.unread_count ?? 0, title = room.dm_peer_name ?? room.name) =>
  renderToStaticMarkup(
    <TeamRoomRow
      room={room}
      title={title}
      unread={unread}
      href={teamHref("org-a", "messages", room.room_id)}
      selected={false}
      viewerNames={["Test owner"]}
      joining={null}
      onJoin={() => {}}
    />
  );

it("renders joined rooms with unread badge, bold title and sender preview", () => {
  const html = row(orgRoom());
  expect(html).toContain('aria-label="3 条未读"');
  expect(html).toContain("font-semibold");
  expect(html).toContain("Alice: ship it");
  expect(html).toContain('href="/chats/team?space=org-a&amp;conversation=rm_1"');
  expect(row(orgRoom({ last_sender_name: "Test owner" }), 0)).toContain("我: ship it");
});

it("titles DMs by peer and badges Agent DMs", () => {
  const html = row(
    orgRoom({
      room_id: "rm_sdm_1",
      space_kind: "dm",
      name: "Test owner & Bot",
      dm_peer_name: "Helper Bot",
      participants: [
        { id: "hu_me", kind: "human", display_name: "Test owner", role: "owner" },
        { id: "ag_h", kind: "agent", display_name: "Helper Bot", role: "member" },
      ],
    }),
    0
  );
  expect(html).toContain("Helper Bot");
  expect(html).not.toContain("Test owner &amp; Bot");
  expect(html).toContain(">Agent<");
});

it("offers joining organization rooms the viewer is not in", () => {
  const html = row(orgRoom({ joined: false, unread_count: 0, last_message_preview: null }), 0);
  expect(html).toContain('data-unjoined-room="rm_1"');
  expect(html).toContain('aria-label="加入 Launch"');
  expect(html).not.toContain("<a ");
});

const memberSpace = {
  id: "org-a",
  kind: "organization",
  status: "active",
  roles: ["member"],
  membership: { id: "m-me", status: "active" },
} as unknown as TeamSpace;
const orgAgents = [
  { agent_id: "ag_mine", display_name: "My Bot", status: "active", sponsor_user_membership_id: "m-me" },
  { agent_id: "ag_other", display_name: "Their Bot", status: "active", sponsor_user_membership_id: "m-2" },
] as SpaceAgent[];

it("lets room creation pull in Agents and explains the ones you can't add", () => {
  const html = renderToStaticMarkup(
    <TeamConversationDialog
      spaceId="org-a"
      space={memberSpace}
      kind="room"
      users={[]}
      agents={orgAgents}
      userId="me"
      onClose={() => {}}
      onCreated={() => {}}
    />
  );
  expect(html).toContain("拉 Agent 进房间");
  expect(html).toContain("My Bot");
  expect(html).toContain("Their Bot");
  expect(html.match(/<input[^>]*value="ag_other"[^>]*>/)?.[0]).toContain('disabled=""');
  expect(html.match(/<input[^>]*value="ag_mine"[^>]*>/)?.[0]).not.toContain("disabled");
  expect(html).toContain("仅 Agent 所有者或组织管理员可添加");
});

it("groups room participants and marks Agents; DMs can't take Agents", () => {
  const participants = [
    { id: "hu_me", kind: "human" as const, display_name: "Test owner", role: "owner" },
    { id: "ag_mine", kind: "agent" as const, display_name: "My Bot", role: "member" },
  ];
  const render = (room: OrgRoom) =>
    renderToStaticMarkup(
      <TeamRoomMembersDialog
        spaceId="org-a"
        space={memberSpace}
        room={room}
        members={{ users: [], agents: orgAgents }}
        viewerId="hu_me"
        ownedAgentIds={["ag_mine"]}
        onClose={() => {}}
        onChanged={() => {}}
      />
    );
  const html = render(orgRoom({ participants }));
  expect(html).toContain("成员与 Agent");
  expect(html).toContain("添加 Agent");
  expect(html).toContain("添加成员");
  expect(html).toContain('aria-label="移除 My Bot"');
  expect(html).not.toContain('aria-label="移除 Test owner"');
  const dm = render(orgRoom({ space_kind: "dm", participants }));
  expect(dm).toContain("私聊不能添加 Agent");
  expect(dm).not.toContain("添加 Agent<");
});

it("hides organization navigation only inside mobile conversations", () => {
  for (const view of ["messages", "rooms", "members", "settings", "agents"]) {
    route.query = new URLSearchParams({ space: "org-a", view, conversation: "rm-test" });
    const html = renderToStaticMarkup(<TeamWorkspace snapshot={snapshot} onMembershipChanged={() => {}} />);
    const aside = html.match(/<aside class="([^"]+)"/)?.[1];
    expect(aside?.includes("max-md:hidden")).toBe(view === "messages" || view === "rooms");
  }
  route.query = new URLSearchParams("space=org-a");
  const html = renderToStaticMarkup(<TeamWorkspace snapshot={snapshot} onMembershipChanged={() => {}} />);
  expect(html.match(/<aside class="([^"]+)"/)?.[1]).not.toContain("max-md:hidden");
});
