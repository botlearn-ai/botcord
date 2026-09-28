import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    auth: {
      getSession: async () => ({
        data: { session: { access_token: "user-token" } },
      }),
    },
  }),
}));
import { ApiError } from "./api";
import {
  admitNewAgent,
  canManage,
  canRemoveUser,
  spaceError,
  teamSpacesApi,
  type SpaceUser,
  type TeamSpace,
} from "./team-spaces";

const space = {
  kind: "organization",
  status: "active",
  membership: { status: "active" },
  roles: ["owner"],
} as TeamSpace;

describe("Team governance API", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset().mockResolvedValue(new Response("{}"));
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("uses user auth and binds invitations to the selected space", async () => {
    await teamSpacesApi.invite("company-a", "hu_alice");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("/api/spaces/company-a/invitations");
    expect(JSON.parse(init.body)).toEqual({ human_id: "hu_alice" });
    expect(new Headers(init.headers).get("Authorization")).toBe(
      "Bearer user-token",
    );
    expect(new Headers(init.headers).has("X-Active-Agent")).toBe(false);
  });
  it("binds policy changes to the displayed version and never enables external communication", async () => {
    await teamSpacesApi.policy("org-a", 7, true);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("/api/organizations/org-a/policies");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body)).toEqual({
      expected_version: 7,
      admin_dm_content_access_enabled: true,
      external_communication_enabled: false,
    });
  });
  it("scopes agent access grants to the space and agent", async () => {
    fetchMock.mockImplementation(async () => new Response("{}"));
    await teamSpacesApi.grantAccess("org-a", "ag_x", {
      user_id: "u-bob",
      role: "consultant",
      expires_at: null,
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("/api/spaces/org-a/agents/ag_x/access-grants");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({
      user_id: "u-bob",
      role: "consultant",
      expires_at: null,
    });
    expect(new Headers(init.headers).has("X-Active-Agent")).toBe(false);
    await teamSpacesApi.accessGrants("org-a", "ag_x");
    expect(fetchMock.mock.calls[1][0]).toContain(
      "/api/spaces/org-a/agents/ag_x/access-grants",
    );
    await teamSpacesApi.revokeAccess("org-a", "g-1");
    expect(fetchMock.mock.calls[2][0]).toContain(
      "/api/spaces/org-a/access-grants/g-1",
    );
    expect(fetchMock.mock.calls[2][1].method).toBe("DELETE");
    await teamSpacesApi.sharedAgents("org-a");
    expect(fetchMock.mock.calls[3][0]).toContain(
      "/api/spaces/org-a/shared-agents",
    );
  });
  it("maps agent sharing errors to readable text", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ detail: "cannot_grant_self" }), {
        status: 422,
      }),
    );
    const error = await teamSpacesApi
      .grantAccess("a", "ag_x", { user_id: "me", role: "consultant", expires_at: null })
      .catch((cause) => cause);
    expect(spaceError(error, true)).toBe("不能授权给自己。");
    expect(spaceError(new ApiError(403, "agent_access_revoked"), true)).toBe(
      "你对该 Agent 的使用授权已被撤销或过期。",
    );
  });
  it("creates, lists and revokes invite links for the selected space", async () => {
    fetchMock.mockImplementation(async () => new Response("{}"));
    await teamSpacesApi.createInviteLink("org-a", { expires_in_days: 7, max_uses: null });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("/api/spaces/org-a/invite-links");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ expires_in_days: 7, max_uses: null });
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer user-token");
    await teamSpacesApi.inviteLinks("org-a");
    expect(fetchMock.mock.calls[1][0]).toContain("/api/spaces/org-a/invite-links");
    expect(fetchMock.mock.calls[1][1].method).toBeUndefined();
    await teamSpacesApi.revokeInviteLink("org-a", "ln/1");
    expect(fetchMock.mock.calls[2][0]).toContain("/api/spaces/org-a/invite-links/ln%2F1");
    expect(fetchMock.mock.calls[2][1].method).toBe("DELETE");
  });
  it("previews org invites without credentials and accepts with user auth", async () => {
    fetchMock.mockImplementation(async () => new Response("{}"));
    await teamSpacesApi.orgInvite("abc");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("/api/org-invites/abc");
    expect(new Headers(init.headers).has("Authorization")).toBe(false);
    await teamSpacesApi.acceptOrgInvite("abc");
    const [acceptUrl, acceptInit] = fetchMock.mock.calls[1];
    expect(acceptUrl).toContain("/api/org-invites/abc/accept");
    expect(acceptInit.method).toBe("POST");
    expect(new Headers(acceptInit.headers).get("Authorization")).toBe("Bearer user-token");
  });
  it("maps invite link errors to readable text", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ detail: "invite_link_expired" }), { status: 410 }),
    );
    const error = await teamSpacesApi.acceptOrgInvite("abc").catch((cause) => cause);
    expect(spaceError(error, true)).toContain("邀请链接已过期");
    expect(spaceError(new ApiError(403, "membership_requires_direct_invite"), false)).toContain(
      "cannot rejoin by link",
    );
    expect(spaceError(new ApiError(404, "invite_link_not_found"), true)).toContain("邀请链接不存在");
  });
  it("adds a new Agent directly for managers and applies for members", async () => {
    fetchMock.mockImplementation(async () => new Response("{}"));
    await expect(admitNewAgent("org-a", "ag_new", true)).resolves.toBe("added");
    expect(fetchMock.mock.calls[0][0]).toContain("/api/spaces/org-a/agents/ag_new/admission/add");
    await expect(admitNewAgent("org-a", "ag_new", false)).resolves.toBe("requested");
    expect(fetchMock.mock.calls[1][0]).toMatch(/\/api\/spaces\/org-a\/agents\/ag_new\/admission$/);
    expect(fetchMock.mock.calls[1][1].method).toBe("POST");
  });
  it("handles empty deletion responses", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await expect(
      teamSpacesApi.removeAgent("a", "barry"),
    ).resolves.toBeUndefined();
  });
  it("preserves stale policy errors for a refresh, without retrying a write", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ detail: "policy_version_stale" }), {
        status: 409,
      }),
    );
    await expect(teamSpacesApi.policy("a", 1, true)).rejects.toMatchObject({
      status: 409,
      message: "policy_version_stale",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("does not expose owner removal or admin-over-admin removal", () => {
    const target = {
      roles: ["owner"],
      status: "active",
      user_id: "other",
    } as SpaceUser;
    expect(canRemoveUser(space, target, "me")).toBe(false);
    expect(
      canRemoveUser(
        { ...space, roles: ["admin"] },
        { ...target, roles: ["admin"] },
        "me",
      ),
    ).toBe(false);
    expect(canRemoveUser(space, { ...target, roles: ["admin"] }, "me")).toBe(
      true,
    );
    expect(
      canManage({
        ...space,
        membership: { ...space.membership, status: "invited" },
      }),
    ).toBe(false);
    expect(canManage({ ...space, kind: "personal" })).toBe(false);
  });
});
