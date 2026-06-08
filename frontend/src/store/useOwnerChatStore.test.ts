import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  DashboardMessage,
  HumanAgentRoomSummary,
  OwnerChatMessage,
  RunStreamBlocksResponse,
} from "@/lib/types";

const mocks = vi.hoisted(() => ({
  getRoomMessages: vi.fn(),
  getRunStreamBlocks: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  api: {
    getRoomMessages: mocks.getRoomMessages,
    getRunStreamBlocks: mocks.getRunStreamBlocks,
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

describe("useOwnerChatStore empty message handling", () => {
  beforeEach(() => {
    mocks.getRoomMessages.mockReset();
    useOwnerChatStore.getState().reset();
    useDashboardChatStore.setState({
      ownedAgentRooms: [makeOwnedAgentRoom()],
      optimisticOwnerChatRooms: {},
    });
    useOwnerChatStore.getState().setRoom("rm_oc_real", "Owned bot");
  });

  it("filters delivered API messages with no visible content", async () => {
    mocks.getRoomMessages.mockResolvedValue({
      messages: [
        makeDashboardMessage({ hub_msg_id: "msg_empty", msg_id: "msg_empty", text: "", payload: {} }),
        makeDashboardMessage({ hub_msg_id: "msg_text", msg_id: "msg_text", text: "visible" }),
      ],
      has_more: false,
    });

    await useOwnerChatStore.getState().loadInitial("rm_oc_real");

    expect(useOwnerChatStore.getState().messages.map((m) => m.hubMsgId)).toEqual(["msg_text"]);
  });

  it("keeps delivered messages that only have visible stream blocks", () => {
    useOwnerChatStore.getState().upsertMessage(makeOwnerChatMessage({
      hubMsgId: "msg_1",
      sender: "agent",
      text: "",
      status: "delivered",
      senderName: "Owned bot",
      streamBlocks: [{
        trace_id: "tr_1",
        seq: 1,
        created_at: "2026-05-19T03:00:00.000Z",
        block: { kind: "reasoning", payload: { text: "reasoning" } },
      }],
    }));

    expect(useOwnerChatStore.getState().messages).toHaveLength(1);
  });

  it("drops delivered messages that only have hidden system stream blocks", () => {
    useOwnerChatStore.getState().upsertMessage(makeOwnerChatMessage({
      hubMsgId: "msg_1",
      sender: "agent",
      text: "",
      status: "delivered",
      senderName: "Owned bot",
      streamBlocks: [{
        trace_id: "tr_1",
        seq: 1,
        created_at: "2026-05-19T03:00:00.000Z",
        block: { kind: "system", payload: { details: "{\"event\":\"turn.started\"}" } },
      }],
    }));

    expect(useOwnerChatStore.getState().messages).toHaveLength(0);
  });
});

describe("useOwnerChatStore stream terminal handling", () => {
  beforeEach(() => {
    mocks.getRoomMessages.mockReset();
    useOwnerChatStore.getState().reset();
    useDashboardChatStore.setState({
      ownedAgentRooms: [makeOwnedAgentRoom()],
      optimisticOwnerChatRooms: {},
    });
    useOwnerChatStore.getState().setRoom("rm_oc_real", "Owned bot");
  });

  it("keeps a streaming placeholder open when a terminal block arrives before the final message", () => {
    useOwnerChatStore.getState().appendStreamBlock({
      trace_id: "msg_trace",
      seq: 1,
      created_at: "2026-05-19T09:00:00.000Z",
      block: { kind: "assistant", payload: { text: "done" } },
    });
    useOwnerChatStore.getState().appendStreamBlock({
      trace_id: "msg_trace",
      seq: 2,
      created_at: "2026-05-19T09:00:01.000Z",
      block: { kind: "other", payload: { terminal: true, event: "turn.completed" } },
    });

    expect(useOwnerChatStore.getState().messages).toMatchObject([
      {
        traceId: "msg_trace",
        text: "done",
        status: "streaming",
        hubMsgId: null,
        streamBlocks: [
          { block: { kind: "assistant" } },
          { block: { kind: "other" } },
        ],
      },
    ]);
    expect(useOwnerChatStore.getState().activeTraceId).toBe("msg_trace");
  });

  it("finalizes a terminal-observed placeholder when the final traced message arrives", () => {
    useOwnerChatStore.getState().appendStreamBlock({
      trace_id: "msg_trace",
      seq: 1,
      created_at: "2026-05-19T09:00:00.000Z",
      block: { kind: "assistant", payload: { text: "streamed answer" } },
    });
    useOwnerChatStore.getState().appendStreamBlock({
      trace_id: "msg_trace",
      seq: 2,
      created_at: "2026-05-19T09:00:01.000Z",
      block: { kind: "other", payload: { terminal: true, event: "turn.completed" } },
    });

    useOwnerChatStore.getState().finalizeStream("msg_trace", {
      hubMsgId: "msg_final",
      text: "answer",
      senderName: "Owned bot",
      createdAt: "2026-05-19T09:00:02.000Z",
    });

    expect(useOwnerChatStore.getState().messages).toHaveLength(1);
    expect(useOwnerChatStore.getState().messages[0]).toMatchObject({
      hubMsgId: "msg_final",
      text: "streamed answer",
      status: "delivered",
      streamBlocks: [{ block: { kind: "other" } }],
    });
  });
});

describe("useOwnerChatStore stream-cache restore", () => {
  beforeEach(() => {
    mocks.getRoomMessages.mockReset();
    mocks.getRunStreamBlocks.mockReset();
    useOwnerChatStore.getState().reset();
    useDashboardChatStore.setState({
      ownedAgentRooms: [makeOwnedAgentRoom()],
      optimisticOwnerChatRooms: {},
    });
    useOwnerChatStore.getState().setRoom("rm_oc_real", "Owned bot");
  });

  function runningRun(overrides: Partial<RunStreamBlocksResponse> = {}): RunStreamBlocksResponse {
    return {
      trace_id: "msg_trace",
      status: "running",
      room_id: "rm_oc_real",
      agent_id: "ag_bot",
      events: [
        {
          seq: 1,
          kind: "tool_call",
          created_at: "2026-05-19T09:00:00.000Z",
          block: { kind: "tool_call", payload: { name: "web_search" } },
        },
        {
          seq: 2,
          kind: "assistant",
          created_at: "2026-05-19T09:00:01.000Z",
          block: { kind: "assistant", payload: { text: "partial" } },
        },
      ],
      ...overrides,
    };
  }

  it("restoreStreamBlocks recreates a streaming placeholder from cached events", () => {
    useOwnerChatStore.getState().restoreStreamBlocks(runningRun());

    const msgs = useOwnerChatStore.getState().messages;
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({
      traceId: "msg_trace",
      status: "streaming",
      hubMsgId: null,
      text: "partial",
    });
    expect(msgs[0].streamBlocks.map((b) => b.seq)).toEqual([1, 2]);
    expect(useOwnerChatStore.getState().activeTraceId).toBe("msg_trace");
  });

  it("dedupes by (trace_id, seq) when a live block re-arrives after restore", () => {
    useOwnerChatStore.getState().restoreStreamBlocks(runningRun());

    // Live WS re-delivers seq 2 (duplicate) and adds a new seq 3.
    useOwnerChatStore.getState().appendStreamBlock({
      trace_id: "msg_trace",
      seq: 2,
      created_at: "2026-05-19T09:00:01.000Z",
      block: { kind: "assistant", payload: { text: "partial" } },
    });
    useOwnerChatStore.getState().appendStreamBlock({
      trace_id: "msg_trace",
      seq: 3,
      created_at: "2026-05-19T09:00:02.000Z",
      block: { kind: "tool_call", payload: { name: "read_file" } },
    });

    const msgs = useOwnerChatStore.getState().messages;
    expect(msgs).toHaveLength(1);
    // seq 2 not duplicated; seq 3 appended.
    expect(msgs[0].streamBlocks.map((b) => b.seq)).toEqual([1, 2, 3]);
  });

  it("does nothing for a completed/empty run (graceful degrade)", () => {
    useOwnerChatStore
      .getState()
      .restoreStreamBlocks(runningRun({ status: "completed", events: [] }));

    expect(useOwnerChatStore.getState().messages).toHaveLength(0);
    expect(useOwnerChatStore.getState().activeTraceId).toBeNull();
  });

  it("restoreActiveRuns fetches + restores only uncovered user-message traces", async () => {
    // A confirmed user message whose reply is still in flight.
    useOwnerChatStore.getState().upsertMessage(
      makeOwnerChatMessage({
        clientId: "u1",
        hubMsgId: "msg_trace",
        sender: "user",
        status: "confirmed",
        text: "do a thing",
      }),
    );
    mocks.getRunStreamBlocks.mockResolvedValue(runningRun());

    await useOwnerChatStore.getState().restoreActiveRuns("ag_bot");

    expect(mocks.getRunStreamBlocks).toHaveBeenCalledTimes(1);
    expect(mocks.getRunStreamBlocks).toHaveBeenCalledWith("msg_trace", "ag_bot");
    const streaming = useOwnerChatStore
      .getState()
      .messages.find((m) => m.traceId === "msg_trace" && m.status === "streaming");
    expect(streaming).toBeTruthy();
  });

  it("restoreActiveRuns skips user messages that already have an agent reply", async () => {
    useOwnerChatStore.getState().upsertMessage(
      makeOwnerChatMessage({
        clientId: "u1",
        hubMsgId: "msg_trace",
        sender: "user",
        status: "confirmed",
        text: "do a thing",
      }),
    );
    // Agent final reply already linked to that trace.
    useOwnerChatStore.getState().upsertMessage(
      makeOwnerChatMessage({
        clientId: "a1",
        hubMsgId: "msg_final",
        sender: "agent",
        status: "delivered",
        text: "done",
        senderName: "Owned bot",
        traceId: "msg_trace",
      }),
    );

    await useOwnerChatStore.getState().restoreActiveRuns("ag_bot");

    expect(mocks.getRunStreamBlocks).not.toHaveBeenCalled();
  });

  it("restoreActiveRuns degrades gracefully when the fetch fails", async () => {
    useOwnerChatStore.getState().upsertMessage(
      makeOwnerChatMessage({
        clientId: "u1",
        hubMsgId: "msg_trace",
        sender: "user",
        status: "confirmed",
        text: "do a thing",
      }),
    );
    mocks.getRunStreamBlocks.mockRejectedValue(new Error("network"));

    await expect(useOwnerChatStore.getState().restoreActiveRuns("ag_bot")).resolves.toBeUndefined();
    // No streaming placeholder created.
    expect(
      useOwnerChatStore.getState().messages.some((m) => m.status === "streaming"),
    ).toBe(false);
  });
});
