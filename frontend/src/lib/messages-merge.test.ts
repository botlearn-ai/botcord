import { describe, expect, it } from "vitest";
import type { DashboardRoom, HumanAgentRoomSummary } from "@/lib/types";
import { applyMessagesFilter, countMessagesByFilter, mergeOwnerVisibleRooms } from "@/lib/messages-merge";

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
      applyMessagesFilter(rooms, "self-my-bot", new Set(["ag_bot"])).map((room) => room.room_id),
    ).toEqual([ownRoom.room_id]);
  });

  it("keeps shared owner-and-bot groups in both self and bot monitoring buckets", () => {
    const ownGroup = makeRoom({
      room_id: "rm_shared_group",
      name: "Shared group",
      member_count: 3,
      owner_id: "hu_owner",
      owner_type: "human",
      last_message_at: "2026-05-13T08:00:00Z",
    });
    const ownedAgentGroup = makeOwnedAgentRoom({
      room_id: "rm_shared_group",
      name: "Shared group",
      owner_id: "hu_owner",
      member_count: 3,
      last_message_at: "2026-05-13T08:00:00Z",
      bots: [{ agent_id: "ag_bot", display_name: "My Bot", role: "member" }],
    });
    const rooms = mergeOwnerVisibleRooms({
      ownRooms: [ownGroup],
      ownedAgentRooms: [ownedAgentGroup],
    });
    const ownedAgentIds = new Set(["ag_bot"]);

    expect(rooms).toHaveLength(2);
    expect(rooms.filter((room) => room.room_id === "rm_shared_group" && !room._originAgent)).toHaveLength(1);
    expect(rooms.filter((room) => room.room_id === "rm_shared_group" && room._originAgent?.agent_id === "ag_bot")).toHaveLength(1);
    expect(applyMessagesFilter(rooms, "self-group", ownedAgentIds).map((room) => room.room_id)).toEqual([
      "rm_shared_group",
    ]);
    expect(applyMessagesFilter(rooms, "bots-group", ownedAgentIds).map((room) => room.room_id)).toEqual([
      "rm_shared_group",
    ]);
    expect(countMessagesByFilter(rooms, ownedAgentIds)).toMatchObject({
      "self-all": 1,
      "self-group": 1,
      "bots-all": 1,
      "bots-group": 1,
    });
  });

  it("keeps non-DM rooms out of private-chat child buckets but includes them in all buckets", () => {
    const ownGroup = makeRoom({
      room_id: "rm_small_room",
      name: "Small room",
      member_count: 2,
      peer_type: "agent",
      owner_id: "ag_bot",
    });
    const botGroup = {
      ...ownGroup,
      room_id: "rm_bot_small_room",
      _originAgent: { agent_id: "ag_bot", display_name: "My Bot" },
    };
    const rooms = [ownGroup, botGroup];
    const ownedAgentIds = new Set(["ag_bot"]);

    expect(applyMessagesFilter(rooms, "self-all", ownedAgentIds).map((room) => room.room_id)).toEqual([
      "rm_small_room",
    ]);
    expect(applyMessagesFilter(rooms, "self-my-bot", ownedAgentIds)).toEqual([]);
    expect(applyMessagesFilter(rooms, "self-group", ownedAgentIds).map((room) => room.room_id)).toEqual([
      "rm_small_room",
    ]);
    expect(applyMessagesFilter(rooms, "bots-all", ownedAgentIds).map((room) => room.room_id)).toEqual([
      "rm_bot_small_room",
    ]);
    expect(applyMessagesFilter(rooms, "bots-bot-bot", ownedAgentIds)).toEqual([]);
    expect(applyMessagesFilter(rooms, "bots-group", ownedAgentIds).map((room) => room.room_id)).toEqual([
      "rm_bot_small_room",
    ]);
    expect(countMessagesByFilter(rooms, ownedAgentIds)).toMatchObject({
      "self-all": 1,
      "self-group": 1,
      "bots-all": 1,
      "bots-group": 1,
    });
  });

  it("classifies human-human DMs as self-human even when peer_type is missing", () => {
    const room = makeRoom({
      room_id: "rm_dm_hu_owner_hu_peer",
      name: "Human peer",
      member_count: 2,
      peer_type: undefined,
    });
    const ownedAgentIds = new Set(["ag_bot"]);

    expect(applyMessagesFilter([room], "self-human", ownedAgentIds).map((r) => r.room_id)).toEqual([
      "rm_dm_hu_owner_hu_peer",
    ]);
    expect(applyMessagesFilter([room], "self-third-bot", ownedAgentIds)).toEqual([]);
    expect(countMessagesByFilter([room], ownedAgentIds)).toMatchObject({
      "self-all": 1,
      "self-human": 1,
      "self-third-bot": 0,
    });
  });

  it("classifies observed bot-human DMs as bots-bot-human when peer_type is missing", () => {
    const room = makeRoom({
      room_id: "rm_dm_ag_bot_hu_peer",
      name: "Bot human peer",
      owner_id: "ag_bot",
      owner_type: "agent",
      member_count: 2,
      peer_type: undefined,
      _originAgent: { agent_id: "ag_bot", display_name: "My Bot" },
    });
    const ownedAgentIds = new Set(["ag_bot"]);

    expect(applyMessagesFilter([room], "bots-bot-human", ownedAgentIds).map((r) => r.room_id)).toEqual([
      "rm_dm_ag_bot_hu_peer",
    ]);
    expect(applyMessagesFilter([room], "bots-bot-bot", ownedAgentIds)).toEqual([]);
  });

  it("classifies owner-chat rm_oc rooms as my own bot conversations", () => {
    const rooms = mergeOwnerVisibleRooms({
      ownRooms: [],
      ownedAgentRooms: [
        makeOwnedAgentRoom({
          room_id: "rm_oc_abc123",
          name: "My Bot",
          owner_id: "ag_bot",
          member_count: 1,
          bots: [{ agent_id: "ag_bot", display_name: "My Bot", role: "owner" }],
        }),
      ],
    });
    const ownedAgentIds = new Set(["ag_bot"]);

    expect(applyMessagesFilter(rooms, "self-my-bot", ownedAgentIds).map((room) => room.room_id)).toEqual([
      "rm_oc_abc123",
    ]);
    expect(applyMessagesFilter(rooms, "self-all", ownedAgentIds).map((room) => room.room_id)).toEqual([
      "rm_oc_abc123",
    ]);
    expect(applyMessagesFilter(rooms, "bots-all", ownedAgentIds)).toEqual([]);
    expect(applyMessagesFilter(rooms, "bots-group", ownedAgentIds)).toEqual([]);
    expect(countMessagesByFilter(rooms, ownedAgentIds)).toMatchObject({
      "self-all": 1,
      "self-my-bot": 1,
      "bots-all": 0,
      "bots-group": 0,
    });
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
