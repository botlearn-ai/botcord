import { describe, expect, it } from "vitest";
import type { SharedMessage } from "@/lib/types";
import {
  getSharedRoomMessageText,
  getSharedRoomOpenHref,
  getSharedRoomPreviewMessages,
  truncateSharedRoomMessageText,
} from "./SharedRoomView";

function makeMessage(index: number, overrides: Partial<SharedMessage> = {}): SharedMessage {
  return {
    hub_msg_id: `hub_${index}`,
    msg_id: `msg_${index}`,
    sender_id: "ag_sender",
    sender_name: "Sender",
    type: "message",
    text: `message ${index}`,
    payload: {},
    created_at: new Date(2026, 0, 1, 0, index).toISOString(),
    ...overrides,
  };
}

describe("getSharedRoomOpenHref", () => {
  it("opens public room shares directly without forcing login", () => {
    expect(getSharedRoomOpenHref({
      entry_type: "public_room",
      continue_url: "https://www.botcord.chat/chats/messages/rm_public",
    })).toBe("/chats/messages/rm_public");
  });

  it("keeps private and paid room shares behind login", () => {
    expect(getSharedRoomOpenHref({
      entry_type: "private_room",
      continue_url: "https://www.botcord.chat/chats/messages/rm_private",
    })).toBe("/login?next=%2Fchats%2Fmessages%2Frm_private");

    expect(getSharedRoomOpenHref({
      entry_type: "paid_room",
      continue_url: "/chats/messages/rm_paid",
    })).toBe("/login?next=%2Fchats%2Fmessages%2Frm_paid");
  });
});

describe("getSharedRoomPreviewMessages", () => {
  it("keeps only the latest 3 messages in chronological order", () => {
    const messages = Array.from({ length: 8 }, (_, index) => makeMessage(index));

    const preview = getSharedRoomPreviewMessages(messages);

    expect(preview).toHaveLength(3);
    expect(preview[0].text).toBe("message 5");
    expect(preview.at(-1)?.text).toBe("message 7");
  });
});

describe("getSharedRoomMessageText", () => {
  it("prefers text-like payload fields over the fallback message text", () => {
    expect(getSharedRoomMessageText(makeMessage(1, {
      text: "fallback",
      payload: { body: "payload body" },
    }))).toBe("payload body");
  });
});

describe("truncateSharedRoomMessageText", () => {
  it("collapses whitespace and truncates long previews", () => {
    const text = "First line\n\nSecond line with extra spaces   and a long ending";

    expect(truncateSharedRoomMessageText(text, 30)).toBe("First line Second line with...");
  });

  it("leaves short preview text untouched after whitespace compaction", () => {
    expect(truncateSharedRoomMessageText("  compact\nmessage  ", 80)).toBe("compact message");
  });
});
