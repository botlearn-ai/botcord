import { describe, expect, it } from "vitest";
import type { DashboardOverview, DashboardRoom, HumanRoomSummary, PublicRoom } from "@/lib/types";
import {
  buildVisibleMessageRooms,
  humanRoomToDashboardRoom,
  isRoomOwnedByCurrentViewer,
  mergeDashboardRoomsWithHumanRooms,
} from "@/store/dashboard-shared";
import { applyMessagesFilter } from "@/lib/messages-merge";

function makePublicRoom(overrides: Partial<PublicRoom> = {}): PublicRoom {
  return {
    room_id: "rm_public_1",
    name: "Public room",
    description: "desc",
    owner_id: "ag_owner",
    visibility: "public",
    join_policy: "open",
    member_count: 3,
    rule: null,
    required_subscription_product_id: null,
    last_message_preview: "hello",
    last_message_at: "2026-04-27T10:00:00Z",
    last_sender_name: "Alice",
    ...overrides,
  };
}

function makeOverview(roomOverrides: Record<string, unknown> = {}): DashboardOverview {
  return {
    agent: null,
    viewer: {
      type: "human",
      id: "hu_1",
      display_name: "Human",
    },
    rooms: [
      {
        room_id: "rm_joined_1",
        name: "Joined room",
        description: "joined",
        owner_id: "ag_owner",
        visibility: "private",
        join_policy: "invite",
        member_count: 2,
        my_role: "member",
        rule: null,
        has_unread: false,
        last_message_preview: "joined",
        last_message_at: "2026-04-27T09:00:00Z",
        last_sender_name: "Bob",
        ...roomOverrides,
      },
    ],
    contacts: [],
    pending_requests: 0,
  };
}

function makeHumanRoom(overrides: Partial<HumanRoomSummary> = {}): HumanRoomSummary {
  return {
    room_id: "rm_human_1",
    name: "Human room",
    description: "human",
    owner_id: "hu_owner",
    owner_type: "human",
    visibility: "private",
    join_policy: "invite",
    member_count: 1,
    my_role: "member",
    allow_human_send: true,
    default_send: true,
    default_invite: true,
    max_members: null,
    slow_mode_seconds: null,
    required_subscription_product_id: null,
    created_at: "2026-04-27T08:00:00Z",
    rule: null,
    ...overrides,
  };
}

describe("buildVisibleMessageRooms", () => {
  it("returns no rooms for guests even if recent rooms exist", () => {
    const rooms = buildVisibleMessageRooms({
      overview: null,
      recentVisitedRooms: [makePublicRoom()],
      token: null,
    });

    expect(rooms).toEqual([]);
  });

  it("merges joined, recent public, and human rooms for logged-in users", () => {
    const rooms = buildVisibleMessageRooms({
      overview: makeOverview(),
      recentVisitedRooms: [makePublicRoom()],
      token: "token",
      humanRooms: [makeHumanRoom()],
    });

    expect(rooms.map((room) => room.room_id)).toEqual(["rm_public_1", "rm_joined_1", "rm_human_1"]);
  });
});

describe("mergeDashboardRoomsWithHumanRooms", () => {
  it("keeps human-owned created rooms visible outside the agent overview", () => {
    const rooms = mergeDashboardRoomsWithHumanRooms(makeOverview().rooms, [
      makeHumanRoom({
        room_id: "rm_created_by_human",
        owner_id: "hu_1",
        my_role: "owner",
        created_at: "2026-04-27T11:00:00Z",
      }),
    ]);

    expect(rooms.map((room) => room.room_id)).toEqual(["rm_created_by_human", "rm_joined_1"]);
    expect(rooms[0]).toMatchObject({
      owner_id: "hu_1",
      owner_type: "human",
      my_role: "owner",
    });
  });

  it("marks human-to-human DMs so the self-human messages filter catches them", () => {
    const room = humanRoomToDashboardRoom(makeHumanRoom({
      room_id: "rm_dm_hu_1_hu_2",
      member_count: 2,
    }));

    expect(room.peer_type).toBe("human");
    expect(applyMessagesFilter([room], "self-human", new Set()).map((r) => r.room_id)).toEqual([
      "rm_dm_hu_1_hu_2",
    ]);
  });
});

describe("applyMessagesFilter", () => {
  function makeDashboardRoom(overrides: Partial<DashboardRoom>): DashboardRoom {
    return {
      room_id: "rm_dm_hu_1_ag_1",
      name: "Room",
      description: "",
      owner_id: "hu_1",
      visibility: "private",
      member_count: 2,
      my_role: "member",
      rule: null,
      has_unread: false,
      last_message_preview: null,
      last_message_at: null,
      last_sender_name: null,
      ...overrides,
    };
  }

  it("shows all self conversations, including groups, in the self-all filter", () => {
    const selfDm = makeDashboardRoom({ room_id: "rm_dm_hu_1_ag_1" });
    const selfGroup = makeDashboardRoom({ room_id: "rm_group_self", member_count: 3 });
    const observedBotGroup = makeDashboardRoom({
      room_id: "rm_group_bot",
      member_count: 3,
      _originAgent: { agent_id: "ag_owned", display_name: "Owned Bot" },
    });

    expect(applyMessagesFilter([selfDm, selfGroup, observedBotGroup], "self-all", new Set()).map((r) => r.room_id)).toEqual([
      "rm_dm_hu_1_ag_1",
      "rm_group_self",
    ]);
  });

  it("shows all observed bot conversations, including groups, in the bots-all filter", () => {
    const selfGroup = makeDashboardRoom({ room_id: "rm_group_self", member_count: 3 });
    const observedBotDm = makeDashboardRoom({
      room_id: "rm_dm_ag_owned_ag_2",
      owner_id: "ag_owned",
      _originAgent: { agent_id: "ag_owned", display_name: "Owned Bot" },
    });
    const observedBotGroup = makeDashboardRoom({
      room_id: "rm_group_bot",
      owner_id: "ag_owned",
      member_count: 3,
      _originAgent: { agent_id: "ag_owned", display_name: "Owned Bot" },
    });

    expect(applyMessagesFilter([selfGroup, observedBotDm, observedBotGroup], "bots-all", new Set()).map((r) => r.room_id)).toEqual([
      "rm_dm_ag_owned_ag_2",
      "rm_group_bot",
    ]);
  });
});

describe("isRoomOwnedByCurrentViewer", () => {
  it("matches human-owned rooms by human id", () => {
    const room = mergeDashboardRoomsWithHumanRooms([], [
      makeHumanRoom({ owner_id: "hu_1", owner_type: "human", my_role: "owner" }),
    ])[0];

    expect(isRoomOwnedByCurrentViewer(room, { activeAgentId: "ag_1", humanId: "hu_1" })).toBe(true);
    expect(isRoomOwnedByCurrentViewer(room, { activeAgentId: "ag_1", humanId: "hu_2" })).toBe(false);
  });

  it("matches agent-owned rooms by active agent id", () => {
    const room = makeOverview({ owner_id: "ag_1" }).rooms[0];

    expect(isRoomOwnedByCurrentViewer(room, { activeAgentId: "ag_1", humanId: "hu_1" })).toBe(true);
    expect(isRoomOwnedByCurrentViewer(room, { activeAgentId: "ag_2", humanId: "hu_1" })).toBe(false);
  });
});
