import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
vi.mock("@/lib/i18n", () => ({ useLanguage: () => "zh" }));
vi.mock("next/navigation", () => ({ usePathname: () => "/chats/team", useRouter: () => ({ push: vi.fn() }) }));
import type { TeamSnapshot } from "@/store/team-space-store";
import type { DirectoryAgent } from "@/lib/team-access";
import type { UserAgent } from "@/lib/types";
import TeamAgentsPage from "./TeamAgentsPage";
import AddAgentDialog from "./AddAgentDialog";
import AgentManageDrawer, { manageTabs } from "./AgentManageDrawer";

const snapshot = (roles: string[], agents: unknown[] = []) =>
  ({
    selected: {
      id: "org-a",
      kind: "organization",
      status: "active",
      roles,
      membership: { id: "m-me", status: "active" },
      agent_direct_admission_available: true,
    },
    spaces: [],
    user: { id: "me", display_name: "Danny", agents: [] },
    human: { human_id: "hu_me" },
    members: {
      users: [
        { id: "m-me", user_id: "me", display_name: "Danny", status: "active", roles },
        { id: "m-bob", user_id: "bob", display_name: "Bob", status: "active", roles: ["member"] },
      ],
      agents,
    },
  }) as unknown as TeamSnapshot;

it("renders one page header with Add Agent, filter tabs and a loading state", () => {
  const html = renderToStaticMarkup(
    <TeamAgentsPage snapshot={snapshot(["member"])} onOpenRoom={() => {}} onChanged={() => {}} />,
  );
  expect(html.match(/<h1/g)).toHaveLength(1);
  expect(html).toContain(">Agent</h1>");
  expect(html).toContain("添加 Agent");
  for (const tab of ["全部", "我的", "我可用"]) expect(html).toContain(tab);
  // Hidden until something needs the viewer.
  expect(html).not.toContain("需要我处理");
  expect(html).not.toContain("个权限申请待处理");
  expect(html).toContain("正在加载 Agent");
  // The old explanatory paragraph and dropdown are gone.
  expect(html).not.toContain("<select");
});

it("shows Agents waiting to join: managers approve, sponsors may cancel", () => {
  const waiting = [
    { id: "a1", agent_id: "ag_new", display_name: "Newbie", status: "invited", sponsor_user_membership_id: "m-bob" },
    { id: "a2", agent_id: "ag_mine", display_name: "Mine", status: "invited", sponsor_user_membership_id: "m-me" },
  ];
  const admin = renderToStaticMarkup(
    <TeamAgentsPage snapshot={snapshot(["admin"], waiting)} onOpenRoom={() => {}} onChanged={() => {}} />,
  );
  expect(admin).toContain("等待加入组织 · 2");
  expect(admin.match(/批准加入/g)).toHaveLength(2);
  expect(admin).toContain("撤销申请");
  const member = renderToStaticMarkup(
    <TeamAgentsPage snapshot={snapshot(["member"], waiting)} onOpenRoom={() => {}} onChanged={() => {}} />,
  );
  expect(member).toContain("等待加入组织 · 1");
  expect(member).not.toContain("Newbie");
  expect(member).not.toContain("批准加入");
});

const mine = [
  { agent_id: "ag_a", display_name: "Alpha", avatar_url: null, ws_online: true },
  { agent_id: "ag_b", display_name: "Beta", avatar_url: null, ws_online: false },
] as UserAgent[];

it("offers picking an Agent or creating one, adding directly for managers", () => {
  const html = renderToStaticMarkup(
    <AddAgentDialog spaceId="org-a" agents={mine} direct onClose={() => {}} onCreateNew={() => {}} onAdded={() => {}} />,
  );
  expect(html).toContain("从我的 Agent 中选择");
  expect(html).toContain("新建 Agent");
  expect(html).toContain('aria-label="添加 Alpha"');
  expect(html).toContain("在线");
  expect(html).toContain("离线");
  expect(html).not.toContain("管理员批准");
});

it("tells members their pick is submitted for approval", () => {
  const html = renderToStaticMarkup(
    <AddAgentDialog spaceId="org-a" agents={mine} direct={false} onClose={() => {}} onCreateNew={() => {}} onAdded={() => {}} />,
  );
  expect(html).toContain("提交后由组织管理员批准");
  expect(html).toContain('aria-label="申请加入：Beta"');
  const none = renderToStaticMarkup(
    <AddAgentDialog spaceId="org-a" agents={[]} direct={false} onClose={() => {}} onCreateNew={() => {}} onAdded={() => {}} />,
  );
  expect(none).toContain("你的 Agent 都已在本组织里");
  expect(none).toContain("新建 Agent");
});

const owned = {
  agent_id: "ag_a",
  display_name: "Alpha",
  owner_user_id: "me",
  owner_name: "Danny",
  owner_human_id: "hu_me",
  my_access: "owner",
  grant_id: null,
  pending_request: null,
  default_reply_mode: "mention_only",
  avatar_url: null,
  runtime: "claude-code",
  hosting_kind: "daemon",
  status: "working",
  room_count: 3,
  grant_count: 2,
  pending_request_count: 1,
} as DirectoryAgent;

it("gives owners every manage tab and managers only removal", () => {
  expect(manageTabs(true, true)).toEqual(["overview", "access", "rooms", "danger"]);
  expect(manageTabs(false, true)).toEqual(["overview", "danger"]);
  expect(manageTabs(false, false)).toEqual(["overview"]);
});

it("opens the drawer on an overview with status, runtime and counts", () => {
  const html = renderToStaticMarkup(
    <AgentManageDrawer
      spaceId="org-a"
      agent={owned}
      isOwner
      canRemove
      pending={1}
      users={[]}
      userId="me"
      chatBusy={false}
      onChat={() => {}}
      onChanged={() => {}}
      onRemoved={() => {}}
      onClose={() => {}}
    />,
  );
  expect(html).toContain('role="dialog"');
  for (const label of ["概览", "谁可以用", "房间与回复", "危险操作"]) expect(html).toContain(label);
  expect(html).toContain("工作中");
  expect(html).toContain("Claude Code");
  expect(html).toContain("人可用");
  expect(html).toContain("处理 1 个申请");
  // Removal lives only in the danger tab.
  expect(html).not.toContain("从组织移除");
});

it("opens straight to the danger zone with a separate remove action", () => {
  const html = renderToStaticMarkup(
    <AgentManageDrawer
      spaceId="org-a"
      agent={{ ...owned, my_access: "none", grant_count: null, pending_request_count: null }}
      isOwner={false}
      canRemove
      pending={0}
      users={[]}
      userId="me"
      initialTab="danger"
      chatBusy={false}
      onChat={null}
      onChanged={() => {}}
      onRemoved={() => {}}
      onClose={() => {}}
    />,
  );
  expect(html).toContain("从组织移除");
  expect(html).not.toContain("谁可以用");
  expect(html).not.toContain("房间与回复");
});
