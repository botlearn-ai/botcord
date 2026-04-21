import { describe, it, expect, vi, beforeEach } from "vitest";

const mockDispatchReply = vi.fn().mockResolvedValue(undefined);
const mockFinalizeInboundContext = vi.fn((ctx: any) => ctx);
const mockFormatAgentEnvelope = vi.fn(({ body }: any) => body);
const mockResolveAgentRoute = vi.fn(() => ({ sessionKey: "session-key" }));

const mockCore = {
  channel: {
    routing: {
      resolveAgentRoute: mockResolveAgentRoute,
    },
    reply: {
      resolveEnvelopeFormatOptions: vi.fn(() => ({})),
      formatAgentEnvelope: mockFormatAgentEnvelope,
      finalizeInboundContext: mockFinalizeInboundContext,
      dispatchReplyWithBufferedBlockDispatcher: mockDispatchReply,
    },
    session: {
      resolveStorePath: vi.fn(() => undefined),
      injectMessage: vi.fn(),
    },
  },
};

vi.mock("../runtime.js", () => ({
  getBotCordRuntime: () => mockCore,
}));

vi.mock("../client.js", () => {
  class MockBotCordClient {
    sendMessage = vi.fn().mockResolvedValue({ hub_msg_id: "h_reply", queued: true, status: "queued" });
    ensureToken = vi.fn().mockResolvedValue("token");
    sendTyping = vi.fn().mockResolvedValue(undefined);
  }
  return { BotCordClient: MockBotCordClient };
});

vi.mock("../config.js", () => ({
  resolveAccountConfig: vi.fn(() => ({
    hubUrl: "http://test",
    agentId: "ag_test",
    keyId: "k_test",
    privateKey: "test_key",
  })),
  resolveChannelConfig: vi.fn(() => ({})),
  resolveAccounts: vi.fn(() => ({})),
  isAccountConfigured: vi.fn(() => true),
  displayPrefix: vi.fn(() => "botcord"),
}));

import { handleInboxMessage, handleInboxMessageBatch } from "../inbound.js";

function makeHumanRoomMessage(overrides: Record<string, any> = {}) {
  return {
    hub_msg_id: "h_human_1",
    envelope: {
      from: "ag_active",
      to: "ag_test",
      type: "message" as const,
      msg_id: "m_human_1",
      ts: Date.now(),
      v: "a2a/0.1",
      reply_to: null,
      ttl_sec: 3600,
      payload: { text: "hello" },
      payload_hash: "sha256:test",
      sig: { alg: "ed25519" as const, key_id: "dashboard", value: "" },
    },
    text: "hello",
    room_id: "rm_group_xyz",
    room_name: "Test Room",
    source_type: "dashboard_human_room" as any,
    source_user_id: "u_alice",
    source_user_name: "Alice",
    source_session_kind: "room_human" as const,
    mentioned: false,
    ...overrides,
  };
}

function makeA2AMessage(overrides: Record<string, any> = {}) {
  return {
    hub_msg_id: "h_a2a_1",
    envelope: {
      from: "ag_sender",
      to: "ag_test",
      type: "message" as const,
      msg_id: "m_a2a_1",
      ts: Date.now(),
      v: "a2a/0.1",
      reply_to: null,
      ttl_sec: 3600,
      payload: { text: "from bot" },
      payload_hash: "sha256:test",
      sig: { alg: "ed25519" as const, key_id: "k_1", value: "sig" },
    },
    text: "from bot",
    room_id: "rm_group_xyz",
    room_name: "Test Room",
    source_type: "agent" as any,
    mentioned: false,
    ...overrides,
  };
}

describe("handleInboxMessage dashboard_human_room dispatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("formats human room messages as <human-message> (not <agent-message>)", async () => {
    const msg = makeHumanRoomMessage();

    await handleInboxMessage(msg, "ag_test", {});

    expect(mockDispatchReply).toHaveBeenCalledTimes(1);
    const fmtCall = mockFormatAgentEnvelope.mock.calls[0][0];
    expect(fmtCall.body).toContain('<human-message sender="Alice">');
    expect(fmtCall.body).toContain("hello");
    expect(fmtCall.body).toContain("</human-message>");
    expect(fmtCall.body).not.toContain("<agent-message");
  });

  it("does NOT route through owner-chat auto-reply (group semantics)", async () => {
    const msg = makeHumanRoomMessage();

    await handleInboxMessage(msg, "ag_test", {});

    const ctx = mockFinalizeInboundContext.mock.calls[0][0];
    // Owner-chat path uses ConversationLabel of "<Name> Chat"; group path uses
    // the room name / sender name. Our room_id is non-DM → group chat.
    expect(ctx.ChatType).toBe("group");
    expect(ctx.ConversationLabel).not.toBe("Alice Chat");
  });

  it("includes the group silent hint in composed content", async () => {
    const msg = makeHumanRoomMessage();

    await handleInboxMessage(msg, "ag_test", {});

    const fmtCall = mockFormatAgentEnvelope.mock.calls[0][0];
    expect(fmtCall.body).toContain(
      'In group chats, do NOT reply unless you are explicitly mentioned or addressed. If no response is needed, reply with exactly "NO_REPLY" and nothing else.',
    );
  });

  it("maps mentioned: true to WasMentioned: true", async () => {
    const msg = makeHumanRoomMessage({ mentioned: true });

    await handleInboxMessage(msg, "ag_test", {});

    const ctx = mockFinalizeInboundContext.mock.calls[0][0];
    expect(ctx.WasMentioned).toBe(true);
  });

  it("maps mentioned: false to WasMentioned: false in a group room", async () => {
    const msg = makeHumanRoomMessage({ mentioned: false });

    await handleInboxMessage(msg, "ag_test", {});

    const ctx = mockFinalizeInboundContext.mock.calls[0][0];
    expect(ctx.WasMentioned).toBe(false);
  });

  it("falls back to 'User' when source_user_name is missing", async () => {
    const msg = makeHumanRoomMessage({ source_user_name: null });

    await handleInboxMessage(msg, "ag_test", {});

    const fmtCall = mockFormatAgentEnvelope.mock.calls[0][0];
    expect(fmtCall.body).toContain('<human-message sender="User">');
  });
});

describe("handleInboxMessageBatch mixed A2A + human-room", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders both tags correctly in a single merged dispatch for the same room", async () => {
    const human = makeHumanRoomMessage({ hub_msg_id: "h_batch_human" });
    const agent = makeA2AMessage({ hub_msg_id: "h_batch_agent" });

    const handled = await handleInboxMessageBatch([agent, human], "ag_test", {});

    // Both messages should be handled in a single batch dispatch
    expect(mockDispatchReply).toHaveBeenCalledTimes(1);
    expect(handled).toContain("h_batch_human");
    expect(handled).toContain("h_batch_agent");

    const fmtCall = mockFormatAgentEnvelope.mock.calls[0][0];
    expect(fmtCall.body).toContain('<agent-message sender="ag_sender">');
    expect(fmtCall.body).toContain('<human-message sender="Alice">');
    expect(fmtCall.body).toContain("from bot");
    expect(fmtCall.body).toContain("hello");
  });
});
