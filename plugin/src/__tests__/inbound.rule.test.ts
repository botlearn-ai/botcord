import { describe, it, expect, vi, beforeEach } from "vitest";

const mockDispatchReply = vi.fn().mockResolvedValue(undefined);
const mockFinalizeInboundContext = vi.fn((ctx) => ctx);
const mockFormatAgentEnvelope = vi.fn(({ body }) => body);
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

import { handleInboxMessage } from "../inbound.js";

describe("handleInboxMessage room rule injection removed", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not inject room rule into message body for group rooms (handled by static context)", async () => {
    await handleInboxMessage(
      {
        hub_msg_id: "h1",
        envelope: {
          from: "ag_sender",
          to: "rm_123",
          type: "message",
          msg_id: "m1",
          ts: 1,
          v: "a2a/0.1",
          reply_to: null,
          ttl_sec: 3600,
          payload: { text: "hello" },
          payload_hash: "sha256:test",
          sig: { alg: "ed25519", key_id: "k1", value: "sig" },
        } as any,
        text: "hello",
        room_id: "rm_123",
        room_name: "Ops Room",
        room_rule: "Keep it focused",
      },
      "ag_receiver",
      {},
    );

    expect(mockDispatchReply).toHaveBeenCalledTimes(1);
    const dispatchArg = mockDispatchReply.mock.calls[0][0];
    expect(dispatchArg.ctx.BodyForAgent).not.toContain("[Room Rule]");
    expect(dispatchArg.ctx.RawBody).not.toContain("[Room Rule]");
  });

  it("does not inject room rule for direct rooms", async () => {
    await handleInboxMessage(
      {
        hub_msg_id: "h2",
        envelope: {
          from: "ag_sender",
          to: "ag_receiver",
          type: "message",
          msg_id: "m2",
          ts: 1,
          v: "a2a/0.1",
          reply_to: null,
          ttl_sec: 3600,
          payload: { text: "hello" },
          payload_hash: "sha256:test",
          sig: { alg: "ed25519", key_id: "k1", value: "sig" },
        } as any,
        text: "hello",
        room_rule: "Keep it focused",
      },
      "ag_receiver",
      {},
    );

    expect(mockDispatchReply).toHaveBeenCalledTimes(1);
    const dispatchArg = mockDispatchReply.mock.calls[0][0];
    expect(dispatchArg.ctx.BodyForAgent).not.toContain("[Room Rule]");
  });
});
