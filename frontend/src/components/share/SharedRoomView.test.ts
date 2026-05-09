import { describe, expect, it } from "vitest";
import { getSharedRoomOpenHref } from "./SharedRoomView";

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
