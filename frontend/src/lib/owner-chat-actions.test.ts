import { describe, expect, it } from "vitest";
import type { OwnerChatMessage } from "@/lib/types";
import { buildOwnerChatForwardQuote, canShowOwnerChatMessageActions } from "@/lib/owner-chat-actions";

function message(overrides: Partial<OwnerChatMessage> = {}): OwnerChatMessage {
  return {
    clientId: "client_1",
    hubMsgId: "hub_1",
    sender: "user",
    text: "hello\nworld",
    streamBlocks: [],
    status: "delivered",
    createdAt: "2026-05-29T08:00:00.000Z",
    senderName: "Alice",
    type: "message",
    ...overrides,
  };
}

describe("owner chat message actions", () => {
  it("shows actions for normal text messages", () => {
    expect(canShowOwnerChatMessageActions(message())).toBe(true);
  });

  it("hides actions for streaming and non-text messages", () => {
    expect(canShowOwnerChatMessageActions(message({ status: "streaming" }))).toBe(false);
    expect(canShowOwnerChatMessageActions(message({ text: "   " }))).toBe(false);
    expect(canShowOwnerChatMessageActions(message({ type: "notification" }))).toBe(false);
  });

  it("builds a quote suitable for forwarding", () => {
    expect(buildOwnerChatForwardQuote(message(), () => "16:00")).toBe(
      "> [转发自 Alice · 16:00]\n> hello\n> world\n",
    );
  });
});
