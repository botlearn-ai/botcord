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
  agentAddBlocker,
  canRemoveParticipant,
  newRoomBody,
  orgRoomPreviewMeta,
  orgRoomsApi,
  orgRoomsForView,
  orgRoomTitle,
  orgRoomToDashboardRoom,
  orgRoomUnread,
  type OrgRoom,
} from "./org-rooms";
import { spaceError, type SpaceAgent, type TeamSpace } from "./team-spaces";

const room = (overrides: Partial<OrgRoom> = {}): OrgRoom => ({
  room_id: "rm_1",
  name: "Product",
  member_count: 3,
  my_role: "member",
  last_message_preview: "hi",
  last_message_at: "2026-09-28T09:00:00Z",
  last_sender_name: "Alice",
  unread_count: 2,
  has_unread: true,
  space_id: "org-a",
  space_kind: "room",
  space_visibility: "organization",
  joined: true,
  participants: [],
  ...overrides,
});
const member = {
  kind: "organization",
  status: "active",
  membership: { id: "m-me", status: "active" },
  roles: ["member"],
} as TeamSpace;
const manager = { ...member, roles: ["admin"] } as TeamSpace;
const agent = (sponsor: string) =>
  ({ agent_id: "ag_x", display_name: "X", status: "active", sponsor_user_membership_id: sponsor }) as SpaceAgent;

describe("organization rooms API", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset().mockImplementation(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("creates rooms with Agents using user auth only", async () => {
    await orgRoomsApi.create("org-a", newRoomBody(" Launch ", "organization", ["u1"], ["ag_x"]));
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("/api/spaces/org-a/rooms");
    expect(init.method).toBe("POST");
    // Organization-wide rooms don't carry an explicit member list.
    expect(JSON.parse(init.body)).toEqual({
      name: "Launch",
      visibility: "organization",
      member_ids: [],
      agent_ids: ["ag_x"],
    });
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer user-token");
    expect(new Headers(init.headers).has("X-Active-Agent")).toBe(false);
    expect(newRoomBody("R", "private", ["u1"], []).member_ids).toEqual(["u1"]);
  });

  it("adds an Agent to a room and surfaces permission errors", async () => {
    await orgRoomsApi.addAgent("org-a", "rm_1", "ag_x");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("/api/spaces/org-a/rooms/rm_1/agents");
    expect(JSON.parse(init.body)).toEqual({ agent_id: "ag_x" });

    fetchMock.mockImplementation(
      async () => new Response(JSON.stringify({ detail: "agent_owner_or_manager_required" }), { status: 403 })
    );
    const error = await orgRoomsApi.addAgent("org-a", "rm_1", "ag_x").catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(spaceError(error, true)).toContain("只有该 Agent 的所有者或组织管理员");
    expect(spaceError(new ApiError(422, "agents_only_in_rooms"), true)).toContain("私聊不能添加 Agent");
  });

  it("opens DMs, Agent DMs, joins and removes through the space", async () => {
    await orgRoomsApi.openDm("org-a", "m-2");
    await orgRoomsApi.openAgentDm("org-a", "ag_x");
    await orgRoomsApi.join("org-a", "rm_1");
    await orgRoomsApi.removeParticipant("org-a", "rm_1", "ag_x");
    const calls = fetchMock.mock.calls.map(([url, init]) => [String(url).replace(/^.*\/api/, "/api"), init.method, init.body]);
    expect(calls).toEqual([
      ["/api/spaces/org-a/dms", "POST", JSON.stringify({ member_id: "m-2" })],
      ["/api/spaces/org-a/agent-dms", "POST", JSON.stringify({ agent_id: "ag_x" })],
      ["/api/spaces/org-a/rooms/rm_1/join", "POST", undefined],
      ["/api/spaces/org-a/rooms/rm_1/participants/ag_x", "DELETE", undefined],
    ]);
  });
});

describe("organization room list mapping", () => {
  it("shows only rooms in the rooms view and DMs by peer name", () => {
    const dm = room({ room_id: "rm_sdm_1", space_kind: "dm", name: "A & B", dm_peer_name: "Bob" });
    expect(orgRoomsForView([room(), dm], "rooms").map((r) => r.room_id)).toEqual(["rm_1"]);
    expect(orgRoomsForView([room(), dm], "messages")).toHaveLength(2);
    expect(orgRoomTitle(dm, "left")).toBe("Bob");
    expect(orgRoomTitle({ ...dm, dm_peer_name: null }, "left")).toBe("left");
    expect(orgRoomTitle(room(), "left")).toBe("Product");
  });

  it("counts unread only for joined rooms and marks own previews", () => {
    expect(orgRoomUnread(room())).toBe(2);
    expect(orgRoomUnread(room({ joined: false, unread_count: 5 }))).toBe(0);
    expect(orgRoomPreviewMeta(room(), ["Me"])).toEqual({ last_message_author_name: "Alice", last_message_mine: false });
    expect(orgRoomPreviewMeta(room({ last_sender_name: "Me" }), [null, "Me"]).last_message_mine).toBe(true);
  });

  it("keeps the space marker on dashboard summaries", () => {
    const summary = orgRoomToDashboardRoom(room());
    expect(summary).toMatchObject({ room_id: "rm_1", space_id: "org-a", space_kind: "room", unread_count: 2 });
  });
});

describe("organization room permissions", () => {
  it("explains instead of hiding Agents the viewer cannot add", () => {
    expect(agentAddBlocker(member, agent("m-other"), [])).toBe("agent_owner_or_manager_required");
    expect(agentAddBlocker(member, agent("m-me"), [])).toBeNull();
    expect(agentAddBlocker(member, agent("m-other"), ["ag_x"])).toBeNull();
    expect(agentAddBlocker(manager, agent("m-other"), [])).toBeNull();
  });

  it("never offers removing the owner, yourself, or anyone in a DM", () => {
    const base = { space: member, viewerId: "hu_me", myRole: "member", ownedAgentIds: ["ag_mine"], isDm: false };
    const ag = (id: string) => ({ id, kind: "agent" as const, display_name: id, role: "member" });
    expect(canRemoveParticipant({ id: "hu_o", kind: "human", display_name: "O", role: "owner" }, { ...base, myRole: "owner" })).toBe(false);
    expect(canRemoveParticipant({ id: "hu_me", kind: "human", display_name: "Me", role: "member" }, base)).toBe(false);
    expect(canRemoveParticipant(ag("ag_mine"), base)).toBe(true);
    expect(canRemoveParticipant(ag("ag_other"), base)).toBe(false);
    expect(canRemoveParticipant(ag("ag_other"), { ...base, myRole: "admin" })).toBe(true);
    expect(canRemoveParticipant(ag("ag_other"), { ...base, space: manager })).toBe(true);
    expect(canRemoveParticipant(ag("ag_mine"), { ...base, isDm: true })).toBe(false);
  });
});
