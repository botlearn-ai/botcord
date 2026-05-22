import { describe, expect, it } from "vitest";
import type { SharedMessage } from "@/lib/types";
import { getSharedRoomOpenHref, getSharedRoomPreviewMessages } from "./SharedRoomView";

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
  it("keeps only the latest 30 messages in chronological order", () => {
    const messages = Array.from({ length: 35 }, (_, index) => ({
      hub_msg_id: `hub_${index}`,
      msg_id: `msg_${index}`,
      sender_id: "ag_sender",
      sender_name: "Sender",
      type: "message",
      text: `message ${index}`,
      payload: {},
      created_at: new Date(2026, 0, 1, 0, index).toISOString(),
    })) satisfies SharedMessage[];

    const preview = getSharedRoomPreviewMessages(messages);

    expect(preview).toHaveLength(30);
    expect(preview[0].text).toBe("message 5");
    expect(preview.at(-1)?.text).toBe("message 34");
  });
});
