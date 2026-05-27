import { describe, expect, it } from "vitest";
import { pickReplyToTarget } from "../gateway/dispatcher.js";
import type { GatewayInboundMessage } from "../gateway/index.js";

function makeMsg(partial: Partial<GatewayInboundMessage> = {}): GatewayInboundMessage {
  return {
    id: partial.id ?? "h_abc123",
    channel: partial.channel ?? "botcord",
    accountId: partial.accountId ?? "ag_me",
    conversation: partial.conversation ?? { id: "rm_room", kind: "group" },
    sender: partial.sender ?? { id: "ag_alice", kind: "agent" },
    text: partial.text ?? "hi",
    raw: partial.raw ?? null,
    receivedAt: partial.receivedAt ?? Date.now(),
    mentioned: partial.mentioned ?? false,
    replyTo: partial.replyTo ?? null,
  };
}

describe("pickReplyToTarget", () => {
  it("returns msg.replyTo when the inbound was already a reply (chain semantics)", () => {
    const result = pickReplyToTarget(
      makeMsg({
        replyTo: "11111111-2222-3333-4444-555555555555",
        id: "h_inbound",
        raw: { envelope: { msg_id: "ignored-because-chain-takes-priority" } },
      }),
    );
    expect(result).toBe("11111111-2222-3333-4444-555555555555");
  });

  it("returns envelope.msg_id (canonical UUID) when present and not chained", () => {
    const result = pickReplyToTarget(
      makeMsg({
        id: "h_inbound",
        raw: { envelope: { msg_id: "11111111-2222-3333-4444-555555555555" } },
      }),
    );
    expect(result).toBe("11111111-2222-3333-4444-555555555555");
    expect(result).not.toMatch(/^h_/);
  });

  it("falls back to hub_msg_id when envelope.msg_id is missing", () => {
    const result = pickReplyToTarget(
      makeMsg({ id: "h_inbound", raw: null }),
    );
    // Hub is lenient (accepts h_* via _load_reply_target), so this is still
    // resolvable on the wire — but the helper should clearly mark the fallback.
    expect(result).toBe("h_inbound");
  });

  it("ignores non-string envelope.msg_id and falls back to hub_msg_id", () => {
    const result = pickReplyToTarget(
      makeMsg({
        id: "h_inbound",
        raw: { envelope: { msg_id: 42 as unknown as string } },
      }),
    );
    expect(result).toBe("h_inbound");
  });
});
