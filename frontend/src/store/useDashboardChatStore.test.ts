import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DashboardOverview } from "@/lib/types";

const mocks = vi.hoisted(() => ({
  getRoomMessages: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  api: {
    getRoomMessages: mocks.getRoomMessages,
  },
  humansApi: {},
  getActiveAgentId: vi.fn(() => null),
}));

import { useDashboardChatStore } from "@/store/useDashboardChatStore";

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

describe("useDashboardChatStore message polling", () => {
  beforeEach(() => {
    mocks.getRoomMessages.mockReset();
    useDashboardChatStore.setState({
      overview: makeOverview(),
      messages: {},
      messagesLoading: {},
      messagesHasMore: {},
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
});
