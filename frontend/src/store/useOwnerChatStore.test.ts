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
import { useDashboardSessionStore } from "@/store/useDashboardSessionStore";
import { findCachedOwnerChatRoom, useOwnerChatStore } from "@/store/useOwnerChatStore";

beforeEach(() => useDashboardChatStore.getState().resetChatState());

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

describe("useOwnerChatStore history loading", () => {
  beforeEach(() => {
    mocks.getRoomMessages.mockReset();
    useOwnerChatStore.getState().reset();
    useDashboardChatStore.setState({
      ownedAgentRooms: [makeOwnedAgentRoom()],
      optimisticOwnerChatRooms: {},
    });
    useOwnerChatStore.getState().setRoom("rm_oc_real", "Owned bot");
  });

  it("drops an older-page response after the owner-chat room changes", async () => {
    let resolvePage!: (result: { messages: DashboardMessage[]; has_more: boolean }) => void;
    mocks.getRoomMessages.mockReturnValue(new Promise((resolve) => {
      resolvePage = resolve;
    }));
    useOwnerChatStore.setState({
      messages: [makeOwnerChatMessage({
        clientId: "current-message",
        hubMsgId: "hub_current",
        sender: "agent",
        senderName: "Owned bot",
        status: "delivered",
      })],
      hasMore: true,
    });

    const request = useOwnerChatStore.getState().loadMore();
    expect(useOwnerChatStore.getState().loadingMore).toBe(true);

    useOwnerChatStore.getState().setRoom("rm_oc_other", "Other bot");
    useOwnerChatStore.getState().addOptimistic(makeOwnerChatMessage({
      clientId: "other-room-local",
      text: "new room message",
    }));
    resolvePage({
      messages: [makeDashboardMessage({
        hub_msg_id: "hub_old_history",
        msg_id: "msg_old_history",
        room_id: "rm_oc_real",
        created_at: "2026-05-19T07:00:00.000Z",
      })],
      has_more: false,
    });
    await request;

    const state = useOwnerChatStore.getState();
    expect(state.roomId).toBe("rm_oc_other");
    expect(state.messages.map((message) => message.clientId)).toEqual(["other-room-local"]);
    expect(state.loadingMore).toBe(false);
  });
});

describe("useOwnerChatStore run failure handling", () => {
  beforeEach(() => {
    useOwnerChatStore.getState().reset();
    useDashboardChatStore.setState({
      ownedAgentRooms: [makeOwnedAgentRoom()],
      optimisticOwnerChatRooms: {},
    });
    useOwnerChatStore.getState().setRoom("rm_oc_real", "Owned bot");
  });

  it("marks the trigger message failed and appends an agent error", () => {
    useOwnerChatStore.getState().addOptimistic(makeOwnerChatMessage({
      clientId: "client_turn",
      text: "hello",
    }));
    useOwnerChatStore.getState().confirmOptimistic(
      "client_turn",
      "h_turn",
      "2026-05-19T09:00:01.000Z",
    );

    useOwnerChatStore.getState().failRun({
      hubMsgId: "h_turn",
      traceId: "h_turn",
      error: "Cloud agent is temporarily unavailable. Please retry in a moment.",
      code: "missing_credentials",
      createdAt: "2026-05-19T09:00:02.000Z",
    });

    expect(useOwnerChatStore.getState().messages).toMatchObject([
      {
        clientId: "client_turn",
        hubMsgId: "h_turn",
        status: "failed",
        error: "Cloud agent is temporarily unavailable. Please retry in a moment.",
        sendText: "hello",
      },
      {
        clientId: "err_h_turn",
        type: "error",
        sender: "agent",
        text: "Cloud agent is temporarily unavailable. Please retry in a moment.",
        payload: {
          error: {
            code: "missing_credentials",
            retryable: true,
          },
        },
      },
    ]);
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

  it("drops a streaming placeholder when the run fails", () => {
    useOwnerChatStore.setState({ agentTyping: true, activeTraceId: "msg_trace" });
    useOwnerChatStore.getState().appendStreamBlock({
      trace_id: "msg_trace",
      seq: 1,
      created_at: "2026-05-19T09:00:00.000Z",
      block: { kind: "thinking", payload: { phase: "updated", label: "Thinking" } },
    });

    useOwnerChatStore.getState().failRun({
      hubMsgId: "msg_trace",
      traceId: "msg_trace",
      error: "Cloud agent is temporarily unavailable. Please retry in a moment.",
    });

    expect(useOwnerChatStore.getState().messages).toMatchObject([
      {
        clientId: "err_msg_trace",
        type: "error",
      },
    ]);
    expect(useOwnerChatStore.getState().agentTyping).toBe(false);
    expect(useOwnerChatStore.getState().activeTraceId).toBeNull();
  });

  it("merges a traced API final message into an existing stream placeholder", () => {
    useOwnerChatStore.getState().appendStreamBlock({
      trace_id: "msg_trace",
      seq: 1,
      created_at: "2026-05-19T09:00:00.000Z",
      block: { kind: "thinking", payload: { phase: "updated", label: "Thinking" } },
    });

    useOwnerChatStore.getState().mergeApiMessages([
      makeDashboardMessage({
        hub_msg_id: "msg_final",
        msg_id: "msg_final",
        sender_id: "ag_bot",
        source_type: "agent",
        text: "final answer",
        payload: { trace_id: "msg_trace", text: "final answer" },
        created_at: "2026-05-19T09:00:02.000Z",
      }),
    ], "append");

    const msgs = useOwnerChatStore.getState().messages;
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({
      hubMsgId: "msg_final",
      traceId: "msg_trace",
      text: "final answer",
      status: "delivered",
      streamBlocks: [{ block: { kind: "thinking" } }],
    });
  });

  it("merges late stream blocks into an already delivered traced message", () => {
    useOwnerChatStore.getState().upsertMessage(makeOwnerChatMessage({
      clientId: "msg_final",
      hubMsgId: "msg_final",
      sender: "agent",
      text: "final answer",
      status: "delivered",
      senderName: "Owned bot",
      traceId: "msg_trace",
    }));

    useOwnerChatStore.getState().appendStreamBlock({
      trace_id: "msg_trace",
      seq: 1,
      created_at: "2026-05-19T09:00:01.000Z",
      block: { kind: "thinking", payload: { phase: "updated", label: "Thinking" } },
    });

    const msgs = useOwnerChatStore.getState().messages;
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({
      hubMsgId: "msg_final",
      text: "final answer",
      streamBlocks: [{ block: { kind: "thinking" } }],
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
    // A confirmed user message whose reply is still in flight. Recent
    // timestamp so it passes the restore age gate.
    useOwnerChatStore.getState().upsertMessage(
      makeOwnerChatMessage({
        clientId: "u1",
        hubMsgId: "msg_trace",
        sender: "user",
        status: "confirmed",
        text: "do a thing",
        createdAt: new Date().toISOString(),
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

  it("drops a restored run when the reader switches to another Bot", async () => {
    let resolveRun!: (run: RunStreamBlocksResponse) => void;
    mocks.getRunStreamBlocks.mockReturnValue(new Promise((resolve) => {
      resolveRun = resolve;
    }));
    useOwnerChatStore.getState().upsertMessage(
      makeOwnerChatMessage({
        clientId: "u1",
        hubMsgId: "msg_trace",
        sender: "user",
        status: "confirmed",
        text: "do a thing",
        createdAt: new Date().toISOString(),
      }),
    );

    const request = useOwnerChatStore.getState().restoreActiveRuns("ag_bot");
    useOwnerChatStore.getState().setRoom("rm_oc_other", "Other bot");
    useOwnerChatStore.getState().addOptimistic(makeOwnerChatMessage({
      clientId: "other-room-local",
      text: "new room message",
    }));
    resolveRun(runningRun());
    await request;

    const state = useOwnerChatStore.getState();
    expect(state.roomId).toBe("rm_oc_other");
    expect(state.messages.map((message) => message.clientId)).toEqual(["other-room-local"]);
    expect(state.messages.some((message) => message.status === "streaming")).toBe(false);
  });

  it("restoreActiveRuns skips uncovered user messages older than the restore window", async () => {
    // An uncovered run that never produced a reply (autonomous work) stays
    // "running" for the full run TTL; stale ones must not be resurrected.
    useOwnerChatStore.getState().upsertMessage(
      makeOwnerChatMessage({
        clientId: "u1",
        hubMsgId: "msg_trace",
        sender: "user",
        status: "confirmed",
        text: "do a thing",
        createdAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      }),
    );
    mocks.getRunStreamBlocks.mockResolvedValue(runningRun());

    await useOwnerChatStore.getState().restoreActiveRuns("ag_bot");

    expect(mocks.getRunStreamBlocks).not.toHaveBeenCalled();
    expect(
      useOwnerChatStore.getState().messages.some((m) => m.status === "streaming"),
    ).toBe(false);
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

  it("restoreActiveRuns skips API agent replies whose payload carries the trace id", async () => {
    mocks.getRoomMessages.mockResolvedValue({
      messages: [
        makeDashboardMessage({
          hub_msg_id: "msg_final",
          msg_id: "msg_final",
          sender_id: "ag_bot",
          source_type: "agent",
          text: "done",
          payload: { trace_id: "msg_trace", text: "done" },
          created_at: "2026-05-19T09:00:02.000Z",
        }),
        makeDashboardMessage({
          hub_msg_id: "msg_trace",
          msg_id: "msg_trace",
          sender_id: "ag_bot",
          source_type: "dashboard_user_chat",
          text: "do a thing",
          payload: { text: "do a thing" },
          created_at: "2026-05-19T09:00:00.000Z",
        }),
      ],
      has_more: false,
    });

    await useOwnerChatStore.getState().loadInitial("rm_oc_real");
    await useOwnerChatStore.getState().restoreActiveRuns("ag_bot");

    expect(mocks.getRunStreamBlocks).not.toHaveBeenCalled();
    expect(useOwnerChatStore.getState().messages.map((m) => m.traceId)).toContain("msg_trace");
  });

  it("restoreActiveRuns degrades gracefully when the fetch fails", async () => {
    useOwnerChatStore.getState().upsertMessage(
      makeOwnerChatMessage({
        clientId: "u1",
        hubMsgId: "msg_trace",
        sender: "user",
        status: "confirmed",
        text: "do a thing",
        createdAt: new Date().toISOString(),
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

describe("useOwnerChatStore reconnect reconciliation", () => {
  beforeEach(() => {
    mocks.getRoomMessages.mockReset();
    useOwnerChatStore.getState().reset();
    useDashboardChatStore.setState({
      ownedAgentRooms: [makeOwnedAgentRoom()],
      optimisticOwnerChatRooms: {},
    });
    useOwnerChatStore.getState().setRoom("rm_oc_real", "Owned bot");
  });

  it("drops a reconnect response after the reader switches rooms", async () => {
    let resolvePage!: (result: { messages: DashboardMessage[]; has_more: boolean }) => void;
    mocks.getRoomMessages.mockReturnValue(new Promise((resolve) => {
      resolvePage = resolve;
    }));
    useOwnerChatStore.setState({
      messages: [makeOwnerChatMessage({
        clientId: "failed-send",
        status: "failed",
        error: "Connection lost",
      })],
    });

    const request = useOwnerChatStore.getState().reconcileAfterReconnect();
    useOwnerChatStore.getState().setRoom("rm_oc_other", "Other bot");
    useOwnerChatStore.getState().addOptimistic(makeOwnerChatMessage({
      clientId: "other-room-local",
      text: "new room message",
    }));
    resolvePage({ messages: [makeDashboardMessage()], has_more: false });
    await request;

    const state = useOwnerChatStore.getState();
    expect(state.roomId).toBe("rm_oc_other");
    expect(state.messages.map((message) => message.clientId)).toEqual(["other-room-local"]);
  });
});

describe("owner-chat cached initialization", () => {
  beforeEach(() => {
    mocks.getRoomMessages.mockReset();
    useOwnerChatStore.getState().reset();
    useDashboardChatStore.setState({ ownedAgentRooms: [makeOwnedAgentRoom()] });
    useOwnerChatStore.getState().setRoom("rm_oc_real", "Owned bot");
  });

  function pendingPage() {
    let resolve!: (page: { messages: DashboardMessage[]; has_more: boolean }) => void;
    const promise = new Promise<{ messages: DashboardMessage[]; has_more: boolean }>((done) => { resolve = done; });
    return { promise, resolve };
  }

  it("finds the selected Bot's real owner room without confusing a group or provisional room", () => {
    expect(findCachedOwnerChatRoom("ag_bot")?.room_id).toBe("rm_oc_real");
    expect(findCachedOwnerChatRoom("ag_other")).toBeNull();
    useDashboardChatStore.setState({ ownedAgentRooms: [
      makeOwnedAgentRoom({ room_id: "rm_group" }),
      makeOwnedAgentRoom({ room_id: "rm_oc_pending_ag_bot" }),
      makeOwnedAgentRoom({ room_id: "rm_oc_wrong_origin", bots: [{ agent_id: "ag_other", display_name: "Other", role: "owner" }] }),
    ] });
    expect(findCachedOwnerChatRoom("ag_bot")).toBeNull();
  });

  it("shows chronological cached history synchronously without mutating or clearing any room cache", async () => {
    const pending = pendingPage();
    mocks.getRoomMessages.mockReturnValue(pending.promise);
    const first = makeDashboardMessage({ hub_msg_id: "first", text: "earlier", created_at: "2026-05-19T07:00:00Z" });
    const second = makeDashboardMessage({ hub_msg_id: "second", text: "later" });
    const cached = [first, second];
    const other = [makeDashboardMessage({ room_id: "rm_oc_other" })];
    useDashboardChatStore.setState({ messages: { rm_oc_real: cached, rm_oc_other: other }, messagesHasMore: { rm_oc_real: true } });
    const load = useOwnerChatStore.getState().loadInitial("rm_oc_real");
    expect(useOwnerChatStore.getState()).toMatchObject({ loading: false, historyLoaded: true, hasMore: true });
    expect(useOwnerChatStore.getState().messages.map((row) => row.text)).toEqual(["earlier", "later"]);
    expect(useDashboardChatStore.getState().messages.rm_oc_real).toBe(cached);
    expect(useDashboardChatStore.getState().messages.rm_oc_other).toBe(other);
    pending.resolve({ messages: [second, first], has_more: true });
    await load;
    expect(cached).toEqual([first, second]);
  });

  it("treats an empty cached page as ready while still refreshing", async () => {
    const pending = pendingPage();
    mocks.getRoomMessages.mockReturnValue(pending.promise);
    useDashboardChatStore.setState({ messages: { rm_oc_real: [] }, messagesHasMore: { rm_oc_real: false } });
    const load = useOwnerChatStore.getState().loadInitial("rm_oc_real");
    expect(useOwnerChatStore.getState()).toMatchObject({ messages: [], historyLoaded: true, loading: false });
    pending.resolve({ messages: [makeDashboardMessage()], has_more: false });
    await load;
    expect(useOwnerChatStore.getState().messages).toHaveLength(1);
  });

  it("joins an unfinished prefetch and does not issue a duplicate history request", async () => {
    const pending = pendingPage();
    mocks.getRoomMessages.mockReturnValue(pending.promise);
    const prefetch = useDashboardChatStore.getState().prefetchRoomMessages("rm_oc_real");
    const load = useOwnerChatStore.getState().loadInitial("rm_oc_real");
    await Promise.resolve();
    expect(mocks.getRoomMessages).toHaveBeenCalledTimes(1);
    expect(useOwnerChatStore.getState().loading).toBe(true);
    pending.resolve({ messages: [makeDashboardMessage()], has_more: false });
    await Promise.all([prefetch, load]);
    expect(useOwnerChatStore.getState().messages).toHaveLength(1);
  });

  it("keeps cached content on background failure and accepts authoritative corrections on retry", async () => {
    useDashboardChatStore.setState({ messages: { rm_oc_real: [makeDashboardMessage({ text: "old" })] } });
    mocks.getRoomMessages.mockRejectedValueOnce(new Error("offline"));
    await useOwnerChatStore.getState().loadInitial("rm_oc_real");
    expect(useOwnerChatStore.getState()).toMatchObject({ historyLoaded: true, loading: false, error: "offline" });
    expect(useOwnerChatStore.getState().messages[0].text).toBe("old");
    mocks.getRoomMessages.mockResolvedValueOnce({ messages: [makeDashboardMessage({ text: "corrected" })], has_more: false });
    await useOwnerChatStore.getState().loadInitial("rm_oc_real");
    expect(useOwnerChatStore.getState().messages[0].text).toBe("corrected");
  });

  it("preserves live, optimistic and streaming rows arriving during refresh", async () => {
    const pending = pendingPage();
    mocks.getRoomMessages.mockReturnValue(pending.promise);
    useDashboardChatStore.setState({ messages: { rm_oc_real: [makeDashboardMessage()] } });
    const load = useOwnerChatStore.getState().loadInitial("rm_oc_real");
    useOwnerChatStore.getState().addOptimistic(makeOwnerChatMessage({ clientId: "optimistic" }));
    useOwnerChatStore.getState().upsertMessage(makeOwnerChatMessage({ clientId: "live", hubMsgId: "live", sender: "agent", text: "new reply", status: "delivered" }));
    useOwnerChatStore.getState().appendStreamBlock({ trace_id: "trace", seq: 1, created_at: "2026-05-19T10:00:00Z", block: { kind: "assistant", payload: { text: "partial" } } });
    pending.resolve({ messages: [makeDashboardMessage()], has_more: false });
    await load;
    expect(useOwnerChatStore.getState().messages.map((row) => row.clientId)).toEqual(["msg_1", "optimistic", "live", "stream_trace"]);
    expect(useOwnerChatStore.getState().messages.at(-1)).toMatchObject({ text: "partial", status: "streaming" });
  });

  it("does not hydrate another room or apply the previous room's delayed initial page", async () => {
    const pending = pendingPage();
    mocks.getRoomMessages.mockReturnValue(pending.promise);
    useDashboardChatStore.setState({ messages: { rm_oc_other: [makeDashboardMessage({ room_id: "rm_oc_other" })] } });
    const load = useOwnerChatStore.getState().loadInitial("rm_oc_real");
    expect(useOwnerChatStore.getState().messages).toEqual([]);
    useOwnerChatStore.getState().setRoom("rm_oc_other", "Other");
    pending.resolve({ messages: [makeDashboardMessage()], has_more: false });
    await load;
    expect(useOwnerChatStore.getState()).toMatchObject({ roomId: "rm_oc_other", messages: [], historyLoaded: false });
  });
});


describe("owner-chat account boundaries", () => {
  function setOwner(humanId: string, token = "session-token") {
    useDashboardSessionStore.setState({ token, human: { human_id: humanId } as NonNullable<ReturnType<typeof useDashboardSessionStore.getState>["human"]> });
  }
  beforeEach(() => {
    mocks.getRoomMessages.mockReset();
    setOwner("hu_first");
    useOwnerChatStore.getState().reset();
    useOwnerChatStore.getState().setRoom("rm_oc_real", "Owned bot");
    useDashboardChatStore.setState({ messages: { rm_oc_real: [makeDashboardMessage()] }, ownedAgentRooms: [makeOwnedAgentRoom()] });
    useOwnerChatStore.setState({ messages: [makeOwnerChatMessage()], historyLoaded: true });
  });

  it("clears both live state and shared history synchronously on logout or a different human", () => {
    setOwner("hu_second");
    expect(useOwnerChatStore.getState()).toMatchObject({ roomId: null, messages: [], historyLoaded: false });
    expect(useDashboardChatStore.getState().messages).toEqual({});
    expect(findCachedOwnerChatRoom("ag_bot")).toBeNull();
    useOwnerChatStore.getState().setRoom("rm_oc_real", "Owned bot");
    useOwnerChatStore.setState({ messages: [makeOwnerChatMessage()] });
    useDashboardSessionStore.setState({ token: null });
    expect(useOwnerChatStore.getState().messages).toEqual([]);
  });

  it("keeps the same human's history during token rotation and selected Bot changes", () => {
    const ownerMessages = useOwnerChatStore.getState().messages;
    const cache = useDashboardChatStore.getState().messages;
    setOwner("hu_first", "rotated-token");
    useDashboardSessionStore.setState({ activeAgentId: "ag_other" });
    expect(useOwnerChatStore.getState().messages).toBe(ownerMessages);
    expect(useDashboardChatStore.getState().messages).toBe(cache);
  });

  it("discards an in-flight initial response after the human account changes", async () => {
    let resolve!: (page: { messages: DashboardMessage[]; has_more: boolean }) => void;
    mocks.getRoomMessages.mockReturnValue(new Promise((done) => { resolve = done; }));
    const request = useOwnerChatStore.getState().loadInitial("rm_oc_real");
    await Promise.resolve();
    setOwner("hu_second");
    resolve({ messages: [makeDashboardMessage()], has_more: false });
    await request;
    expect(useOwnerChatStore.getState()).toMatchObject({ roomId: null, messages: [], historyLoaded: false });
    expect(useDashboardChatStore.getState().messages).toEqual({});
  });
});

it("keeps already loaded older owner history and terminal pagination during newest-page refresh", async () => {
  useDashboardSessionStore.setState({ token: "session-token" });
  useOwnerChatStore.getState().reset();
  useOwnerChatStore.getState().setRoom("rm_oc_real", "Owned bot");
  const old = makeOwnerChatMessage({ clientId: "old", hubMsgId: "old", createdAt: "2026-05-18T00:00:00Z", status: "delivered" });
  useOwnerChatStore.setState({ messages: [old], historyLoaded: true, hasMore: false });
  useDashboardChatStore.setState({ messages: { rm_oc_real: [makeDashboardMessage()] }, messagesHasMore: { rm_oc_real: true } });
  mocks.getRoomMessages.mockResolvedValue({ messages: [makeDashboardMessage()], has_more: true });
  await useOwnerChatStore.getState().loadInitial("rm_oc_real");
  expect(useOwnerChatStore.getState().messages.map((message) => message.hubMsgId)).toEqual(["old", "msg_1"]);
  expect(useOwnerChatStore.getState().hasMore).toBe(false);
});

describe("shared owner initial loads", () => {
  beforeEach(() => {
    mocks.getRoomMessages.mockReset();
    useOwnerChatStore.getState().reset();
    useOwnerChatStore.getState().setRoom("rm_oc_real", "Owned bot");
  });

  it("keeps a reopened pane awaiting the pending refresh while rendering its cached history", async () => {
    let resolve!: (page: { messages: DashboardMessage[]; has_more: boolean }) => void;
    mocks.getRoomMessages.mockReturnValue(new Promise((done) => { resolve = done; }));
    useDashboardChatStore.setState({ messages: { rm_oc_real: [makeDashboardMessage({ text: "cached" })] } });
    const first = useOwnerChatStore.getState().loadInitial("rm_oc_real");
    const reopened = useOwnerChatStore.getState().loadInitial("rm_oc_real");
    expect(reopened).toBe(first);
    expect(useOwnerChatStore.getState()).toMatchObject({ historyLoaded: true, loading: false });
    expect(useOwnerChatStore.getState().messages[0].text).toBe("cached");
    let reopenedFinished = false;
    void reopened.then(() => { reopenedFinished = true; });
    await Promise.resolve();
    await Promise.resolve();
    expect(reopenedFinished).toBe(false);
    expect(mocks.getRoomMessages).toHaveBeenCalledTimes(1);
    resolve({ messages: [makeDashboardMessage({ text: "fresh" })], has_more: false });
    await reopened;
    expect(reopenedFinished).toBe(true);
    expect(useOwnerChatStore.getState().messages[0].text).toBe("fresh");
  });

  it("publishes the shared promise before cache hydration can synchronously reenter", async () => {
    mocks.getRoomMessages.mockResolvedValue({ messages: [], has_more: false });
    useDashboardChatStore.setState({ messages: { rm_oc_real: [] } });
    let joined: Promise<void> | undefined;
    const unsubscribe = useOwnerChatStore.subscribe((state) => {
      if (state.historyLoaded && !joined) joined = state.loadInitial("rm_oc_real");
    });
    const request = useOwnerChatStore.getState().loadInitial("rm_oc_real");
    unsubscribe();
    expect(joined).toBe(request);
    await request;
    expect(mocks.getRoomMessages).toHaveBeenCalledTimes(1);
  });
});
