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
  },
};

vi.mock("../runtime.js", () => ({
  getBotCordRuntime: () => mockCore,
}));

// Mock the BotCordClient and reply dispatcher
vi.mock("../client.js", () => {
  class MockBotCordClient {
    sendMessage = vi.fn().mockResolvedValue({ hub_msg_id: "h_reply", queued: true, status: "queued" });
    ensureToken = vi.fn().mockResolvedValue("token");
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

import { handleInboxMessage } from "../inbound.js";

function makeInboxMessage(overrides: Record<string, any> = {}) {
  return {
    hub_msg_id: "h_test",
    envelope: {
      from: "user:abc-123",
      to: "ag_test",
      type: "message" as const,
      msg_id: "m_test",
      ts: Date.now(),
      v: "a2a/0.1",
      reply_to: null,
      ttl_sec: 3600,
      payload: { text: "Hello agent!" },
      payload_hash: "sha256:test",
      sig: { alg: "ed25519" as const, key_id: "dashboard", value: "" },
    },
    text: "Hello agent!",
    room_id: "rm_oc_abc123",
    source_type: "dashboard_user_chat" as const,
    source_user_id: "abc-123",
    source_user_name: "Alice",
    source_session_kind: "owner_chat" as const,
    ...overrides,
  };
}

describe("handleInboxMessage user chat dispatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("routes dashboard_user_chat messages through auto-reply path", async () => {
    const msg = makeInboxMessage();

    await handleInboxMessage(msg, "ag_test", {});

    // Should dispatch via buffered block dispatcher (auto-reply)
    expect(mockDispatchReply).toHaveBeenCalledTimes(1);

    // Verify the context was finalized
    expect(mockFinalizeInboundContext).toHaveBeenCalledTimes(1);
    const ctx = mockFinalizeInboundContext.mock.calls[0][0];

    // User chat should be treated as direct chat
    expect(ctx.ChatType).toBe("direct");
    // Should always be mentioned (it's a direct owner message)
    expect(ctx.WasMentioned).toBe(true);
    // Conversation label should include the user name
    expect(ctx.ConversationLabel).toBe("Alice Chat");
    // SenderName should use the user's display name
    expect(ctx.SenderName).toBe("Alice");
  });

  it("does not include NO_REPLY hints in user chat messages", async () => {
    const msg = makeInboxMessage();

    await handleInboxMessage(msg, "ag_test", {});

    // The formatted body should NOT contain NO_REPLY hint
    const fmtCall = mockFormatAgentEnvelope.mock.calls[0][0];
    expect(fmtCall.body).not.toContain("NO_REPLY");
    expect(fmtCall.body).toContain("Hello agent!");
    // Owner messages are trusted — no structural headers added
    expect(fmtCall.body).toBe("Hello agent!");
    // Should use the user's display name
    expect(fmtCall.from).toBe("Alice");
  });

  it("falls back to 'Owner' when source_user_name is null", async () => {
    const msg = makeInboxMessage({ source_user_name: null });

    await handleInboxMessage(msg, "ag_test", {});

    const ctx = mockFinalizeInboundContext.mock.calls[0][0];
    expect(ctx.SenderName).toBe("Owner");
    expect(ctx.ConversationLabel).toBe("Owner Chat");

    const fmtCall = mockFormatAgentEnvelope.mock.calls[0][0];
    expect(fmtCall.from).toBe("Owner");
  });

  it("routes regular agent messages through A2A path (with NO_REPLY)", async () => {
    const msg = makeInboxMessage({
      source_type: "agent",
      source_user_id: null,
      source_session_kind: null,
      room_id: "rm_dm_ag_a_ag_b",
      envelope: {
        from: "ag_sender",
        to: "ag_test",
        type: "message",
        msg_id: "m_test",
        ts: Date.now(),
        v: "a2a/0.1",
        reply_to: null,
        ttl_sec: 3600,
        payload: { text: "A2A hello" },
        payload_hash: "sha256:test",
        sig: { alg: "ed25519" as const, key_id: "k_1", value: "sig" },
      },
      text: "A2A hello",
    });

    await handleInboxMessage(msg, "ag_test", {});

    // Should still dispatch
    expect(mockDispatchReply).toHaveBeenCalledTimes(1);

    // The formatted body SHOULD contain NO_REPLY hint (A2A mode)
    const fmtCall = mockFormatAgentEnvelope.mock.calls[0][0];
    expect(fmtCall.body).toContain("NO_REPLY");
  });

  it("handles messages without explicit source_type as A2A", async () => {
    const msg = makeInboxMessage({
      source_type: undefined,
      room_id: "rm_dm_ag_a_ag_b",
      envelope: {
        from: "ag_sender",
        to: "ag_test",
        type: "message",
        msg_id: "m_test",
        ts: Date.now(),
        v: "a2a/0.1",
        reply_to: null,
        ttl_sec: 3600,
        payload: { text: "Legacy message" },
        payload_hash: "sha256:test",
        sig: { alg: "ed25519" as const, key_id: "k_1", value: "sig" },
      },
      text: "Legacy message",
    });

    await handleInboxMessage(msg, "ag_test", {});

    // Should use A2A path (contains NO_REPLY)
    const fmtCall = mockFormatAgentEnvelope.mock.calls[0][0];
    expect(fmtCall.body).toContain("NO_REPLY");
  });

  it("uses owner-chat room as reply target for user chat", async () => {
    const msg = makeInboxMessage({ room_id: "rm_oc_myroom123" });

    await handleInboxMessage(msg, "ag_test", {});

    // The dispatcher options should include a deliver function
    const dispatchCall = mockDispatchReply.mock.calls[0][0];
    expect(dispatchCall.dispatcherOptions).toBeDefined();
    expect(typeof dispatchCall.dispatcherOptions.deliver).toBe("function");
  });
});
