import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DashboardOverview, HumanAgentRoomSummary } from "@/lib/types";

const mocks = vi.hoisted(() => ({
  getRoomMessages: vi.fn(),
  leaveRoom: vi.fn(),
  getOverview: vi.fn(),
  getPublicRoom: vi.fn(),
  listAgentRooms: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  api: {
    getRoomMessages: mocks.getRoomMessages,
    leaveRoom: mocks.leaveRoom,
    getOverview: mocks.getOverview,
    getPublicRoom: mocks.getPublicRoom,
  },
  humansApi: {
    listAgentRooms: mocks.listAgentRooms,
  },
  getActiveAgentId: vi.fn(() => null),
  setActiveAgentId: vi.fn(),
  getStoredActiveIdentity: vi.fn(() => null),
  setStoredActiveIdentity: vi.fn(),
}));

import { useDashboardChatStore } from "@/store/useDashboardChatStore";
import { useDashboardSessionStore } from "@/store/useDashboardSessionStore";
import { useDashboardUIStore } from "@/store/useDashboardUIStore";

function makeOverview(lastMessageAt: string | null = null): DashboardOverview {
  return {
    agent: null,
    viewer: {
      type: "human",
      id: "hu_1",
      display_name: "Human",
    },
    rooms: [
      {
        room_id: "rm_empty",
        name: "Empty room",
        description: "",
        owner_id: "ag_owner",
        visibility: "private",
        join_policy: "invite",
        member_count: 1,
        my_role: "member",
        rule: null,
        required_subscription_product_id: null,
        has_unread: false,
        last_message_preview: null,
        last_message_at: lastMessageAt,
        last_sender_name: null,
      },
    ],
    contacts: [],
    pending_requests: 0,
  };
}

function makeOwnedAgentRoom(overrides: Partial<HumanAgentRoomSummary> = {}): HumanAgentRoomSummary {
  return {
    room_id: "rm_oc_real",
    name: "Owned bot",
    description: null,
    rule: null,
    owner_id: "ag_bot",
    visibility: "private",
    join_policy: "invite_only",
    member_count: 1,
    created_at: "2026-05-14T00:00:00.000Z",
    required_subscription_product_id: null,
    last_message_preview: null,
    last_message_at: "2026-05-14T00:00:00.000Z",
    last_sender_name: null,
    allow_human_send: true,
    members_preview: null,
    bots: [{ agent_id: "ag_bot", display_name: "Owned bot", role: "owner" }],
    ...overrides,
  };
}

describe("useDashboardChatStore message polling", () => {
  beforeEach(() => {
    mocks.getRoomMessages.mockReset();
    mocks.leaveRoom.mockReset();
    mocks.getOverview.mockReset();
    mocks.getPublicRoom.mockReset();
    mocks.listAgentRooms.mockReset();
    useDashboardSessionStore.setState({
      token: "test-token",
      activeIdentity: { type: "human", id: "hu_1" },
    });
    useDashboardUIStore.setState({
      focusedRoomId: null,
      openedRoomId: null,
      openedTopicId: null,
    });
    useDashboardChatStore.setState({
      overview: makeOverview(),
      overviewRefreshing: false,
      overviewErrored: false,
      error: null,
      messages: {},
      messagesLoading: {},
      messagesHasMore: {},
      ownedAgentRooms: [],
      optimisticOwnerChatRooms: {},
    });
    useDashboardSessionStore.setState({
      token: "token",
      activeIdentity: { type: "human", id: "hu_1" },
    });
  });

  it("does not refetch a room already loaded as empty when the room snapshot is unchanged", async () => {
    mocks.getRoomMessages.mockResolvedValue({ messages: [], has_more: false });

    await useDashboardChatStore.getState().loadRoomMessages("rm_empty");
    await useDashboardChatStore.getState().pollNewMessages("rm_empty");

    expect(mocks.getRoomMessages).toHaveBeenCalledTimes(1);
    expect(useDashboardChatStore.getState().messages.rm_empty).toEqual([]);
  });

  it("refetches an empty room after the room summary indicates a newer message", async () => {
    mocks.getRoomMessages.mockResolvedValue({ messages: [], has_more: false });

    await useDashboardChatStore.getState().loadRoomMessages("rm_empty");
    useDashboardChatStore.setState({ overview: makeOverview("2026-05-11T08:00:00Z") });
    await useDashboardChatStore.getState().pollNewMessages("rm_empty");

    expect(mocks.getRoomMessages).toHaveBeenCalledTimes(2);
  });

  it("clears the opened room and cached messages after leaving the current room", async () => {
    const overviewAfterLeave = { ...makeOverview(), rooms: [] };
    mocks.leaveRoom.mockResolvedValue(undefined);
    mocks.getOverview.mockResolvedValue(overviewAfterLeave);
    mocks.getPublicRoom.mockResolvedValue({ rooms: [] });
    useDashboardUIStore.setState({
      focusedRoomId: "rm_empty",
      openedRoomId: "rm_empty",
      openedTopicId: "topic_1",
    });
    useDashboardChatStore.setState({
      overview: makeOverview("2026-05-11T08:00:00Z"),
      messages: {
        rm_empty: [
          {
            hub_msg_id: "msg_1",
            msg_id: "msg_1",
            room_id: "rm_empty",
            sender_id: "hu_2",
            sender_name: "Sender",
            type: "text",
            text: "stale message",
            payload: {},
            topic: null,
            topic_id: null,
            goal: null,
            state: "sent",
            state_counts: null,
            created_at: "2026-05-11T08:00:00Z",
            sender_avatar_url: null,
            is_mine: false,
          },
        ],
      },
      messagesLoading: { rm_empty: false },
      messagesHasMore: { rm_empty: false },
    });

    await useDashboardChatStore.getState().leaveRoom("rm_empty");

    expect(useDashboardUIStore.getState().focusedRoomId).toBeNull();
    expect(useDashboardUIStore.getState().openedRoomId).toBeNull();
    expect(useDashboardUIStore.getState().openedTopicId).toBeNull();
    expect(useDashboardChatStore.getState().messages.rm_empty).toBeUndefined();
    expect(mocks.getRoomMessages).not.toHaveBeenCalled();
  });

  it("does not show a global error toast when background overview refresh hits auth expiry", async () => {
    const err = new Error("Unauthorized") as Error & { status: number };
    err.status = 401;
    mocks.getOverview.mockRejectedValue(err);

    await useDashboardChatStore.getState().refreshOverview();

    expect(useDashboardChatStore.getState().error).toBeNull();
    expect(useDashboardChatStore.getState().overviewRefreshing).toBe(false);
    expect(useDashboardChatStore.getState().overviewErrored).toBe(false);
  });

  it("inserts an optimistic owner-chat room immediately", () => {
    useDashboardChatStore.getState().upsertOptimisticOwnerChatRoom({
      agent_id: "ag_bot",
      display_name: "Owned bot",
    });

    const state = useDashboardChatStore.getState();
    expect(state.ownedAgentRooms).toHaveLength(1);
    expect(state.ownedAgentRooms[0]).toMatchObject({
      room_id: "rm_oc_pending_ag_bot",
      name: "Owned bot",
      owner_id: "ag_bot",
      bots: [{ agent_id: "ag_bot", display_name: "Owned bot", role: "owner" }],
    });
  });

  it("reconciles an optimistic owner-chat room when the backend returns the real room", async () => {
    useDashboardChatStore.getState().upsertOptimisticOwnerChatRoom({
      agent_id: "ag_bot",
      display_name: "Owned bot",
    });
    mocks.listAgentRooms.mockResolvedValue({
      rooms: [makeOwnedAgentRoom({ room_id: "rm_oc_real_123" })],
    });

    await useDashboardChatStore.getState().loadOwnedAgentRooms();

    const state = useDashboardChatStore.getState();
    expect(state.optimisticOwnerChatRooms).toEqual({});
    expect(state.ownedAgentRooms.map((room) => room.room_id)).toEqual(["rm_oc_real_123"]);
  });

  it("does not wipe an existing owner-chat preview when reopening the same bot chat", () => {
    useDashboardChatStore.setState({
      ownedAgentRooms: [
        makeOwnedAgentRoom({
          room_id: "rm_oc_existing",
          last_message_preview: "existing preview",
          last_sender_name: "Owned bot",
        }),
      ],
      optimisticOwnerChatRooms: {},
    });

    useDashboardChatStore.getState().upsertOptimisticOwnerChatRoom({
      agent_id: "ag_bot",
      display_name: "Owned bot",
    });

    expect(useDashboardChatStore.getState().ownedAgentRooms[0]).toMatchObject({
      room_id: "rm_oc_existing",
      last_message_preview: "existing preview",
      last_sender_name: "Owned bot",
    });
  });
});
