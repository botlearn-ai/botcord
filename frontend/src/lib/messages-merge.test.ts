import { describe, expect, it } from "vitest";
import type { DashboardRoom, HumanAgentRoomSummary } from "@/lib/types";
import { applyMessagesFilter, mergeOwnerVisibleRooms } from "@/lib/messages-merge";

function makeHumanDmRoom(overrides: Partial<DashboardRoom> = {}): DashboardRoom {
  return {
    room_id: "rm_dm_ag_bot_hu_owner",
    name: "My Bot",
    description: "",
    owner_id: "hu_owner",
    owner_type: "human",
    visibility: "private",
    join_policy: "invite",
    member_count: 2,
    my_role: "member",
    rule: null,
    required_subscription_product_id: null,
    last_viewed_at: null,
    has_unread: false,
    last_message_preview: null,
    last_message_at: "2026-05-13T08:00:00Z",
    last_sender_name: null,
    peer_type: "agent",
    ...overrides,
  };
}

function makeOwnedAgentRoom(overrides: Partial<HumanAgentRoomSummary> = {}): HumanAgentRoomSummary {
  return {
    room_id: "rm_dm_ag_bot_hu_owner",
    name: "My Bot",
    description: "",
    owner_id: "hu_owner",
    visibility: "private",
    join_policy: "invite",
    member_count: 2,
    bots: [{ agent_id: "ag_bot", display_name: "My Bot", role: "member" }],
    created_at: "2026-05-13T07:00:00Z",
    rule: null,
    required_subscription_product_id: null,
    last_message_preview: null,
    last_message_at: "2026-05-13T08:00:00Z",
    last_sender_name: null,
    allow_human_send: true,
    ...overrides,
  };
}

describe("messages merge filters", () => {
  it("keeps a human-owned DM with my bot in the self-my-bot bucket", () => {
    const ownRoom = makeHumanDmRoom();
    const ownedAgentRoom = makeOwnedAgentRoom();
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
