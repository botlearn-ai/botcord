import { describe, expect, it } from "vitest";
import type { OwnerChatMessage } from "@/lib/types";
import {
  buildOwnerChatForwardQuote,
  buildOwnerChatReplyPreview,
  canReplyToOwnerChatMessage,
  canShowOwnerChatMessageActions,
  ownerChatReplyTargetId,
} from "@/lib/owner-chat-actions";

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

  it("allows replies only after a server message id exists", () => {
    expect(canReplyToOwnerChatMessage(message({ hubMsgId: "h_123", status: "delivered" }))).toBe(true);
    expect(canReplyToOwnerChatMessage(message({ hubMsgId: "h_123", status: "confirmed" }))).toBe(true);
    expect(canReplyToOwnerChatMessage(message({ hubMsgId: null, status: "optimistic" }))).toBe(false);
    expect(canReplyToOwnerChatMessage(message({ hubMsgId: null, status: "failed" }))).toBe(false);
  });

  it("uses hub_msg_id as the owner-chat reply target", () => {
    expect(ownerChatReplyTargetId(message({ hubMsgId: "h_reply" }))).toBe("h_reply");
    expect(ownerChatReplyTargetId(message({ hubMsgId: null }))).toBeNull();
  });

  it("builds a local reply preview for optimistic owner-chat sends", () => {
    expect(buildOwnerChatReplyPreview(message({ hubMsgId: "h_reply" }))).toEqual({
      msg_id: "h_reply",
      sender_id: null,
      sender_display_name: "Alice",
      text_preview: "hello\nworld",
      topic_id: null,
      deleted: false,
    });
  });

  it("builds a quote suitable for forwarding", () => {
    expect(buildOwnerChatForwardQuote(message(), () => "16:00")).toBe(
      "> [转发自 Alice · 16:00]\n> hello\n> world\n",
    );
  });
});
