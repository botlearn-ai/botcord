import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
const auth = vi.hoisted(() => ({ getSession: vi.fn() }));
vi.mock("@/lib/i18n", () => ({ useLanguage: () => "zh" }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({ auth }) }));
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  userApi: { getMe: vi.fn() },
}));
vi.mock("@/lib/team-spaces", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/team-spaces")>();
  return { ...actual, teamSpacesApi: { ...actual.teamSpacesApi, orgInvite: vi.fn() } };
});
import { userApi } from "@/lib/api";
import { teamSpacesApi, type OrgInvitePreview } from "@/lib/team-spaces";
import { OrgInviteCard, loadOrgInviteLanding } from "./OrgInviteLanding";

const preview: OrgInvitePreview = {
  space_id: "sp_1",
  organization_name: "Acme",
  inviter_name: "Danny",
  member_count: 3,
  status: "active",
  expires_at: null,
};

describe("organization invite landing", () => {
  beforeEach(() => vi.resetAllMocks());

  it("asks guests to sign in or sign up and returns them to the invite", () => {
    const html = renderToStaticMarkup(<OrgInviteCard code="abc" preview={preview} auth="guest" />);
    expect(html).toContain("Acme");
    expect(html).toContain("Danny");
    expect(html).toContain("3 位成员");
    expect(html).toContain("登录 / 注册后加入");
    expect(html).toContain(`href="/login?next=${encodeURIComponent("/join/abc")}"`);
    expect(html).not.toContain("加入 Acme");
  });
  it("offers signed-in users a direct join button", () => {
    const html = renderToStaticMarkup(<OrgInviteCard code="abc" preview={preview} auth="authed" />);
    expect(html).toContain("加入 Acme");
    expect(html).not.toContain("登录 / 注册后加入");
    const joining = renderToStaticMarkup(<OrgInviteCard code="abc" preview={preview} auth="authed" joining />);
    expect(joining).toContain("正在加入");
    expect(joining).toMatch(/<button[^>]*disabled=""/);
  });
  it("explains unusable invites without any accept action", () => {
    for (const [status, reason] of [
      ["expired", "已过期"],
      ["exhausted", "使用次数上限"],
      ["revoked", "已被管理员撤销"],
      ["unavailable", "组织当前不可用"],
    ] as const) {
      const html = renderToStaticMarkup(
        <OrgInviteCard code="abc" preview={{ ...preview, status }} auth="authed" />,
      );
      expect(html).toContain(reason);
      expect(html).not.toContain("加入 Acme");
      expect(html).not.toContain("登录 / 注册后加入");
    }
  });
  it("shows accept errors from the server", () => {
    const html = renderToStaticMarkup(
      <OrgInviteCard code="abc" preview={preview} auth="authed" error="邀请链接已过期" />,
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain("邀请链接已过期");
  });
  it("resolves guests and signed-in users independently of the preview", async () => {
    vi.mocked(teamSpacesApi.orgInvite).mockResolvedValue(preview);
    auth.getSession.mockResolvedValue({ data: { session: null } });
    const guest = { preview: vi.fn(), error: vi.fn(), auth: vi.fn() };
    loadOrgInviteLanding("abc", guest);
    await vi.waitFor(() => expect(guest.auth).toHaveBeenCalledWith("guest"));
    expect(guest.preview).toHaveBeenCalledWith(preview);
    expect(userApi.getMe).not.toHaveBeenCalled();

    auth.getSession.mockResolvedValue({ data: { session: { access_token: "t" } } });
    vi.mocked(userApi.getMe).mockRejectedValue(new Error("offline"));
    const signedIn = { preview: vi.fn(), error: vi.fn(), auth: vi.fn() };
    loadOrgInviteLanding("abc", signedIn);
    await vi.waitFor(() => expect(signedIn.auth).toHaveBeenCalledWith("authed"));
  });
  it("ignores results after cancellation", async () => {
    vi.mocked(teamSpacesApi.orgInvite).mockResolvedValue(preview);
    auth.getSession.mockResolvedValue({ data: { session: null } });
    const output = { preview: vi.fn(), error: vi.fn(), auth: vi.fn() };
    loadOrgInviteLanding("abc", output)();
    await new Promise((r) => setTimeout(r, 0));
    expect(output.preview).not.toHaveBeenCalled();
    expect(output.auth).not.toHaveBeenCalled();
  });
});
