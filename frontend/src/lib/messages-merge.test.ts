import { describe, expect, it } from "vitest";
import type { DashboardRoom, HumanAgentRoomSummary } from "@/lib/types";
import { applyMessagesFilter, mergeOwnerVisibleRooms } from "@/lib/messages-merge";

function makeRoom(overrides: Partial<DashboardRoom> = {}): DashboardRoom {
  return {
    room_id: "rm_room",
    name: "Room",
    description: "",
    owner_id: "hu_owner",
    owner_type: "human",
    visibility: "private",
    join_policy: "invite",
    member_count: 1,
    my_role: "owner",
    created_at: "2026-05-11T08:00:00Z",
    rule: null,
    required_subscription_product_id: null,
    last_viewed_at: null,
    has_unread: false,
    unread_count: 0,
    last_message_preview: null,
    last_message_at: null,
    last_sender_name: null,
    ...overrides,
  };
}

function makeHumanDmRoom(overrides: Partial<DashboardRoom> = {}): DashboardRoom {
  return makeRoom({
    room_id: "rm_dm_ag_bot_hu_owner",
    name: "My Bot",
    member_count: 2,
    my_role: "member",
    last_message_at: "2026-05-13T08:00:00Z",
    peer_type: "agent",
    ...overrides,
  });
}

function makeOwnedAgentRoom(overrides: Partial<HumanAgentRoomSummary> = {}): HumanAgentRoomSummary {
  return {
    room_id: "rm_bot_room",
    name: "Bot room",
    description: "",
    rule: null,
    owner_id: "ag_owner",
    visibility: "private",
    join_policy: "invite",
    member_count: 2,
    created_at: "2026-05-11T09:00:00Z",
    required_subscription_product_id: null,
    last_message_preview: null,
    last_message_at: null,
    last_sender_name: null,
    allow_human_send: true,
    bots: [{ agent_id: "ag_owner", display_name: "Bot", role: "owner" }],
    ...overrides,
  };
}

describe("messages merge filters", () => {
  it("keeps a human-owned DM with my bot in the self-my-bot bucket", () => {
    const ownRoom = makeHumanDmRoom();
    const ownedAgentRoom = makeOwnedAgentRoom({
      room_id: "rm_dm_ag_bot_hu_owner",
      name: "My Bot",
      owner_id: "hu_owner",
      created_at: "2026-05-13T07:00:00Z",
      last_message_at: "2026-05-13T08:00:00Z",
      bots: [{ agent_id: "ag_bot", display_name: "My Bot", role: "member" }],
    });
    const rooms = mergeOwnerVisibleRooms({
      ownRooms: [ownRoom],
      ownedAgentRooms: [ownedAgentRoom],
    });

    expect(rooms).toHaveLength(1);
    expect(rooms[0]._originAgent).toBeUndefined();
    expect(
      applyMessagesFilter(rooms, "self-my-bot", new Set([ownedAgentRoom.room_id])).map((room) => room.room_id),
    ).toEqual([ownRoom.room_id]);
  });
});

describe("mergeOwnerVisibleRooms", () => {
  it("falls back to created_at when sorting rooms without messages", () => {
    const rooms = mergeOwnerVisibleRooms({
      ownRooms: [
        makeRoom({
          room_id: "rm_old_message",
          created_at: "2026-05-10T08:00:00Z",
          last_message_at: "2026-05-11T08:00:00Z",
          last_message_preview: "older activity",
        }),
        makeRoom({
          room_id: "rm_new_empty",
          created_at: "2026-05-12T08:00:00Z",
          last_message_at: null,
        }),
      ],
      ownedAgentRooms: [],
    });

    expect(rooms.map((room) => room.room_id)).toEqual(["rm_new_empty", "rm_old_message"]);
  });

  it("applies the same created_at fallback to owned bot rooms", () => {
    const rooms = mergeOwnerVisibleRooms({
      ownRooms: [
        makeRoom({
          room_id: "rm_old_message",
          last_message_at: "2026-05-11T08:00:00Z",
        }),
      ],
      ownedAgentRooms: [
        makeOwnedAgentRoom({
          room_id: "rm_new_empty_bot_room",
          created_at: "2026-05-12T08:00:00Z",
          last_message_at: null,
        }),
      ],
    });

    expect(rooms.map((room) => room.room_id)).toEqual(["rm_new_empty_bot_room", "rm_old_message"]);
  });
});
