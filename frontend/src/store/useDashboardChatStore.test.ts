import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DashboardMessage, DashboardOverview, HumanAgentRoomSummary } from "@/lib/types";

const mocks = vi.hoisted(() => ({
  getRoomMessages: vi.fn(),
  leaveRoom: vi.fn(),
  getOverview: vi.fn(),
  getPublicRoom: vi.fn(),
  recallRoomMessage: vi.fn(),
  listAgentRooms: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  api: {
    getRoomMessages: mocks.getRoomMessages,
    leaveRoom: mocks.leaveRoom,
    getOverview: mocks.getOverview,
    getPublicRoom: mocks.getPublicRoom,
    recallRoomMessage: mocks.recallRoomMessage,
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

function makeMessage(overrides: Partial<DashboardMessage> = {}): DashboardMessage {
  return {
    hub_msg_id: "hub_1",
    msg_id: "msg_1",
    sender_id: "hu_1",
    sender_name: "Human",
    type: "message",
    text: "hello",
    payload: { text: "hello" },
    room_id: "rm_empty",
    topic: null,
    topic_id: null,
    goal: null,
    state: "queued",
    state_counts: null,
    created_at: "2026-05-11T08:00:00Z",
    is_mine: true,
    ...overrides,
  };
}

describe("useDashboardChatStore message polling", () => {
  beforeEach(() => {
    mocks.getRoomMessages.mockReset();
    mocks.leaveRoom.mockReset();
    mocks.getOverview.mockReset();
    mocks.getPublicRoom.mockReset();
    mocks.recallRoomMessage.mockReset();
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
      ownedAgents: [],
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

  it("prefetches messages only when a room has no cached page", async () => {
    mocks.getRoomMessages.mockResolvedValue({ messages: [], has_more: false });

    await useDashboardChatStore.getState().prefetchRoomMessages("rm_empty");
    await useDashboardChatStore.getState().prefetchRoomMessages("rm_empty");

    expect(mocks.getRoomMessages).toHaveBeenCalledTimes(1);
    expect(useDashboardChatStore.getState().messages.rm_empty).toEqual([]);
  });

  it("merges a full room reload by stable msg id instead of replacing attachment objects", async () => {
    const attachment = {
      filename: "screenshot.png",
      url: "https://api.botcord.chat/hub/files/f_image",
      content_type: "image/png",
      size_bytes: 1234,
    };
    const existingAttachments = [attachment];
    useDashboardChatStore.setState({
      messages: {
        rm_empty: [
          makeMessage({
            hub_msg_id: "hub_sender_row",
            msg_id: "msg_shared",
            payload: { text: "hello", attachments: existingAttachments },
          }),
        ],
      },
    });
    mocks.getRoomMessages.mockResolvedValue({
      messages: [
        makeMessage({
          hub_msg_id: "hub_representative_row",
          msg_id: "msg_shared",
          payload: { text: "hello", attachments: [{ ...attachment }] },
        }),
      ],
      has_more: false,
    });

    await useDashboardChatStore.getState().loadRoomMessages("rm_empty");

    const [message] = useDashboardChatStore.getState().messages.rm_empty;
    expect(message.hub_msg_id).toBe("hub_representative_row");
    expect(message.msg_id).toBe("msg_shared");
    expect(message.payload.attachments).toBe(existingAttachments);
  });

  it("deduplicates polled messages by stable msg id when hub rows differ", async () => {
    useDashboardChatStore.setState({
      messages: {
        rm_empty: [
          makeMessage({
            hub_msg_id: "hub_sender_row",
            msg_id: "msg_shared",
          }),
        ],
      },
    });
    mocks.getRoomMessages.mockResolvedValue({
      messages: [
        makeMessage({
          hub_msg_id: "hub_representative_row",
          msg_id: "msg_shared",
        }),
      ],
      has_more: false,
    });

    await useDashboardChatStore.getState().pollNewMessages("rm_empty");

    expect(useDashboardChatStore.getState().messages.rm_empty).toHaveLength(1);
    expect(useDashboardChatStore.getState().messages.rm_empty[0].hub_msg_id).toBe("hub_sender_row");
  });

  it("marks a cached message recalled after the backend confirms recall", async () => {
    mocks.recallRoomMessage.mockResolvedValue({
      room_id: "rm_empty",
      msg_id: "msg_1",
      hub_msg_id: "hub_1",
      is_recalled: true,
      recalled_at: "2026-05-11T08:01:00Z",
      recalled_by_id: "hu_1",
      recalled_by_type: "human",
    });
    useDashboardChatStore.setState({
      overview: makeOverview("2026-05-11T08:00:00Z"),
      messages: {
        rm_empty: [{
          hub_msg_id: "hub_1",
          msg_id: "msg_1",
          sender_id: "hu_1",
          sender_name: "Human",
          type: "message",
          text: "hello",
          payload: { text: "hello" },
          room_id: "rm_empty",
          topic: null,
          topic_id: null,
          goal: null,
          state: "queued",
          state_counts: null,
          created_at: "2026-05-11T08:00:00Z",
          is_mine: true,
        }],
      },
    });

    await useDashboardChatStore.getState().recallMessage("rm_empty", "msg_1");

    const message = useDashboardChatStore.getState().messages.rm_empty[0];
    expect(message.is_recalled).toBe(true);
    expect(message.text).toBe("");
    expect(message.payload.recalled).toBe(true);
    expect(message.recalled_at).toBe("2026-05-11T08:01:00Z");
    expect(useDashboardChatStore.getState().overview?.rooms[0].last_message_preview).toBe("Message recalled");
  });

  it("patches an optimistic message with persisted ids after send returns", () => {
    useDashboardChatStore.getState().insertMessage("rm_empty", {
      hub_msg_id: "tmp_1",
      msg_id: "tmp_1",
      sender_id: "hu_1",
      sender_name: "Human",
      type: "message",
      text: "hello",
      payload: { text: "hello" },
      room_id: "rm_empty",
      topic: null,
      topic_id: null,
      goal: null,
      state: "queued",
      state_counts: null,
      created_at: "2026-05-11T08:00:00Z",
      is_mine: true,
    });

    useDashboardChatStore.getState().patchMessageIdentity("rm_empty", "tmp_1", {
      hub_msg_id: "h_real",
      msg_id: "msg_real",
      topic_id: "tp_real",
    });

    expect(useDashboardChatStore.getState().messages.rm_empty[0]).toMatchObject({
      hub_msg_id: "h_real",
      msg_id: "msg_real",
      topic_id: "tp_real",
    });
  });

  it("does not wipe the optimistic msg id when send returns no canonical msg id", () => {
    useDashboardChatStore.getState().insertMessage("rm_empty", {
      hub_msg_id: "tmp_1",
      msg_id: "tmp_1",
      sender_id: "hu_1",
      sender_name: "Human",
      type: "message",
      text: "hello",
      payload: { text: "hello" },
      room_id: "rm_empty",
      topic: null,
      topic_id: null,
      goal: null,
      state: "queued",
      state_counts: null,
      created_at: "2026-05-11T08:00:00Z",
      is_mine: true,
    });

    useDashboardChatStore.getState().patchMessageIdentity("rm_empty", "tmp_1", {
      hub_msg_id: "h_real",
      msg_id: undefined,
    });

    expect(useDashboardChatStore.getState().messages.rm_empty[0]).toMatchObject({
      hub_msg_id: "h_real",
      msg_id: "tmp_1",
    });
  });

  it("reloads an expected sent message when the cached row still has a temporary msg id", async () => {
    mocks.getRoomMessages.mockResolvedValue({
      messages: [{
        hub_msg_id: "h_real",
        msg_id: "msg_real",
        sender_id: "hu_1",
        sender_name: "Human",
        type: "message",
        text: "hello",
        payload: { text: "hello" },
        room_id: "rm_empty",
        topic: null,
        topic_id: null,
        goal: null,
        state: "queued",
        state_counts: null,
        created_at: "2026-05-11T08:00:00Z",
        is_mine: true,
      }],
      has_more: false,
    });
    useDashboardChatStore.setState({
      messages: {
        rm_empty: [{
          hub_msg_id: "h_real",
          msg_id: "tmp_1",
          sender_id: "hu_1",
          sender_name: "Human",
          type: "message",
          text: "hello",
          payload: { text: "hello" },
          room_id: "rm_empty",
          topic: null,
          topic_id: null,
          goal: null,
          state: "queued",
          state_counts: null,
          created_at: "2026-05-11T08:00:00Z",
          is_mine: true,
        }],
      },
    });

    await useDashboardChatStore.getState().pollNewMessages("rm_empty", {
      expectedHubMsgId: "h_real",
      retries: 4,
    });

    expect(mocks.getRoomMessages).toHaveBeenCalledWith("rm_empty", { limit: 50 });
    expect(useDashboardChatStore.getState().messages.rm_empty[0]).toMatchObject({
      hub_msg_id: "h_real",
      msg_id: "msg_real",
    });
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

  it("deduplicates concurrent overview refreshes", async () => {
    let resolveOverview!: (overview: DashboardOverview) => void;
    mocks.getOverview.mockReturnValue(new Promise<DashboardOverview>((resolve) => {
      resolveOverview = resolve;
    }));

    const first = useDashboardChatStore.getState().refreshOverview();
    const second = useDashboardChatStore.getState().refreshOverview();

    expect(mocks.getOverview).toHaveBeenCalledTimes(1);
    resolveOverview(makeOverview("2026-05-11T08:00:00Z"));
    await Promise.all([first, second]);
    expect(useDashboardChatStore.getState().overview?.rooms[0].last_message_at).toBe("2026-05-11T08:00:00Z");
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

  it("deduplicates concurrent owner-chat room loads", async () => {
    let resolveRooms!: (result: { rooms: HumanAgentRoomSummary[] }) => void;
    mocks.listAgentRooms.mockReturnValue(new Promise<{ rooms: HumanAgentRoomSummary[] }>((resolve) => {
      resolveRooms = resolve;
    }));

    const first = useDashboardChatStore.getState().loadOwnedAgentRooms();
    const second = useDashboardChatStore.getState().loadOwnedAgentRooms();

    expect(mocks.listAgentRooms).toHaveBeenCalledTimes(1);
    resolveRooms({ rooms: [makeOwnedAgentRoom({ room_id: "rm_oc_deduped" })] });
    await Promise.all([first, second]);
    expect(useDashboardChatStore.getState().ownedAgentRooms.map((room) => room.room_id)).toEqual(["rm_oc_deduped"]);
  });

  it("keeps an owner-chat row for a new owned bot when the backend has no room yet", async () => {
    useDashboardSessionStore.setState({
      ownedAgents: [{
        agent_id: "ag_barry",
        display_name: "Barry",
        is_default: false,
        claimed_at: "2026-05-18T00:00:00.000Z",
        ws_online: false,
      }],
    });
    mocks.listAgentRooms.mockResolvedValue({ rooms: [] });

    await useDashboardChatStore.getState().loadOwnedAgentRooms();

    expect(useDashboardChatStore.getState().ownedAgentRooms).toEqual([
      expect.objectContaining({
        room_id: "rm_oc_pending_ag_barry",
        name: "Barry",
        owner_id: "ag_barry",
        created_at: "2026-05-18T00:00:00.000Z",
        last_message_at: null,
        bots: [{ agent_id: "ag_barry", display_name: "Barry", role: "owner" }],
      }),
    ]);
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
