import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TeamSnapshot } from "@/store/team-space-store";
const fixture = vi.hoisted(() => ({
  snapshot: null as TeamSnapshot | null,
  spaceId: "a" as string | null,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => ({ get: () => fixture.spaceId }),
}));
vi.mock("@/lib/i18n", () => ({ useLanguage: () => "zh" }));
vi.mock("@/store/team-space-store", async () => {
  const { createStore } = await import("zustand/vanilla");
  return {
    createTeamSpaceStore: () =>
      createStore(() => ({
        snapshot: fixture.snapshot,
        loading: false,
        error: null,
        load: vi.fn(),
        cancel: vi.fn(),
      })),
  };
});
import TeamSpacesPage from "./TeamSpacesPage";

describe("Team governance rendering", () => {
  beforeEach(() => {
    fixture.spaceId = "a";
    fixture.snapshot = {
      selected: {
        id: "a",
        kind: "organization",
        status: "active",
        name: "Acme",
        roles: ["owner"],
        membership: { id: "m", status: "active" },
        policy_version: 1,
        admin_dm_content_access_enabled: false,
      },
      spaces: [],
      user: { id: "me", display_name: "Danny", agents: [] },
      human: { human_id: "hu_me" },
      members: { users: [], agents: [] },
    } as unknown as TeamSnapshot;
    fixture.snapshot.spaces = [fixture.snapshot.selected];
  });
  it("offers creation and joining when Team mode has no organization", () => {
    fixture.spaceId = null;
    fixture.snapshot!.selected.kind = "personal";
    const html = renderToStaticMarkup(<TeamSpacesPage teamMode />);
    expect(html).toContain("开启你的团队空间");
    expect(html).toContain("开始创建");
    expect(html).toContain("加入组织");
    expect(html).not.toContain("你的个人空间");
    expect(html).not.toContain("当前空间");
  });
  it("shows the selected organization on initial Team entry", () => {
    fixture.spaceId = null;
    const html = renderToStaticMarkup(<TeamSpacesPage teamMode />);
    expect(html).toContain("Acme");
    expect(html).toContain("邀请用户");
    expect(html).not.toContain("开启你的团队空间");
  });
  it("lets owners manage settings while explaining the unopened content entry", () => {
    const html = renderToStaticMarkup(<TeamSpacesPage />);
    expect(html).toContain("邀请用户");
    expect(html).toContain("私聊内容查看入口尚未开放");
    const toggle = html.match(/<button[^>]*role="switch"[^>]*>/)?.[0];
    expect(toggle).toBeDefined();
    expect(toggle).not.toContain(' disabled=""');
    expect(html).not.toContain('href="/chats/messages"');
  });
  it("does not expose invitation or policy mutation to ordinary members", () => {
    fixture.snapshot!.selected.roles = ["member"];
    const html = renderToStaticMarkup(<TeamSpacesPage />);
    expect(html).not.toContain("邀请用户");
    expect(html.match(/<button[^>]*role="switch"[^>]*>/)?.[0]).toContain(
      ' disabled=""',
    );
    expect(html).toContain("申请加入");
  });
  it("shows policy scope before accepting an invitation and hides member tools", () => {
    fixture.snapshot!.selected.membership.status = "invited";
    fixture.snapshot!.selected.admin_dm_content_access_enabled = true;
    const html = renderToStaticMarkup(<TeamSpacesPage />);
    expect(html).toContain("接受邀请");
    expect(html).toContain("全部组织私聊历史");
    expect(html).not.toContain("申请加入");
    expect(html).not.toContain("邀请用户");
  });
  it("hides the previous organization's contents as soon as the URL changes", () => {
    fixture.spaceId = "b";
    const html = renderToStaticMarkup(<TeamSpacesPage />);
    expect(html).not.toContain("Acme");
    expect(html).not.toContain("邀请用户");
  });
});
