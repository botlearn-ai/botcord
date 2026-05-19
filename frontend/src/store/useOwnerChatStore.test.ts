import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DashboardMessage, HumanAgentRoomSummary, OwnerChatMessage } from "@/lib/types";

const mocks = vi.hoisted(() => ({
  getRoomMessages: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  api: {
    getRoomMessages: mocks.getRoomMessages,
  },
  humansApi: {
    listAgentRooms: vi.fn(),
  },
  getActiveAgentId: vi.fn(() => null),
  setActiveAgentId: vi.fn(),
  getStoredActiveIdentity: vi.fn(() => null),
  setStoredActiveIdentity: vi.fn(),
}));

import { useDashboardChatStore } from "@/store/useDashboardChatStore";
import { useOwnerChatStore } from "@/store/useOwnerChatStore";

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
    last_message_at: null,
    last_sender_name: null,
    allow_human_send: true,
    members_preview: null,
    bots: [{ agent_id: "ag_bot", display_name: "Owned bot", role: "owner" }],
    ...overrides,
  };
}

function makeDashboardMessage(overrides: Partial<DashboardMessage> = {}): DashboardMessage {
  return {
    hub_msg_id: "msg_1",
    msg_id: "msg_1",
    room_id: "rm_oc_real",
    sender_id: "ag_bot",
    sender_name: "Owned bot",
    type: "text",
    text: "hello from bot",
    payload: {},
    topic: null,
    topic_id: null,
    goal: null,
    state: "sent",
    state_counts: null,
    created_at: "2026-05-19T08:00:00.000Z",
    sender_avatar_url: null,
    is_mine: false,
    ...overrides,
  };
}

function makeOwnerChatMessage(overrides: Partial<OwnerChatMessage> = {}): OwnerChatMessage {
  return {
    clientId: "client_1",
    hubMsgId: null,
    sender: "user",
    text: "local hello",
    streamBlocks: [],
    status: "optimistic",
    createdAt: "2026-05-19T09:00:00.000Z",
    senderName: "You",
    type: "message",
    ...overrides,
  };
}

describe("useOwnerChatStore room summaries", () => {
  beforeEach(() => {
    mocks.getRoomMessages.mockReset();
    useOwnerChatStore.getState().reset();
    useDashboardChatStore.setState({
      ownedAgentRooms: [makeOwnedAgentRoom()],
      optimisticOwnerChatRooms: {},
    });
  });

  it("patches the owner-chat room summary after initial load", async () => {
    mocks.getRoomMessages.mockResolvedValue({
      messages: [makeDashboardMessage()],
      has_more: false,
    });
    useOwnerChatStore.getState().setRoom("rm_oc_real", "Owned bot");

    await useOwnerChatStore.getState().loadInitial("rm_oc_real");

    expect(useDashboardChatStore.getState().ownedAgentRooms[0]).toMatchObject({
      last_message_at: "2026-05-19T08:00:00.000Z",
      last_message_preview: "hello from bot",
      last_sender_name: "Owned bot",
    });
  });

  it("patches the owner-chat room summary for optimistic sends", () => {
    useOwnerChatStore.getState().setRoom("rm_oc_real", "Owned bot");

    useOwnerChatStore.getState().addOptimistic(makeOwnerChatMessage());

    expect(useDashboardChatStore.getState().ownedAgentRooms[0]).toMatchObject({
      last_message_at: "2026-05-19T09:00:00.000Z",
      last_message_preview: "local hello",
      last_sender_name: "You",
    });
  });

  it("moves owner-chat rows by the latest local message time", () => {
    useDashboardChatStore.setState({
      ownedAgentRooms: [
        makeOwnedAgentRoom({
          room_id: "rm_oc_other",
          owner_id: "ag_other",
          last_message_at: "2026-05-19T08:30:00.000Z",
          last_message_preview: "other room",
          bots: [{ agent_id: "ag_other", display_name: "Other bot", role: "owner" }],
        }),
        makeOwnedAgentRoom(),
      ],
      optimisticOwnerChatRooms: {},
    });
    useOwnerChatStore.getState().setRoom("rm_oc_real", "Owned bot");

    useOwnerChatStore.getState().addOptimistic(makeOwnerChatMessage());

    expect(useDashboardChatStore.getState().ownedAgentRooms.map((room) => room.room_id)).toEqual([
      "rm_oc_real",
      "rm_oc_other",
    ]);
  });
});
