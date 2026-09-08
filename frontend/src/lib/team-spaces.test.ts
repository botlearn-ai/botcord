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
import {
  canManage,
  canRemoveUser,
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
