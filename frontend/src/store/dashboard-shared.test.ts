import { describe, expect, it } from "vitest";
import type { DashboardOverview, HumanRoomSummary, PublicRoom } from "@/lib/types";
import { buildVisibleMessageRooms } from "@/store/dashboard-shared";

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
    visibility: "private",
    join_policy: "invite",
    my_role: "member",
    created_at: "2026-04-27T08:00:00Z",
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