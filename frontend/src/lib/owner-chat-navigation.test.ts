import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/lib/api";
import type { HumanAgentRoomSummary } from "@/lib/types";
import { useDashboardChatStore as chat } from "@/store/useDashboardChatStore";
import { useDashboardUIStore as ui } from "@/store/useDashboardUIStore";
import { openOwnerChat } from "./owner-chat-navigation";

const prefetchRoomMessages = chat.getState().prefetchRoomMessages;
const bot = { agent_id: "ag_owned", display_name: "Owned bot" };
const ownerRoom = (roomId = "rm_oc_real"): HumanAgentRoomSummary => ({
  room_id: roomId, name: "Owned bot", description: null, rule: null,
  owner_id: bot.agent_id, visibility: "private", member_count: 1,
  last_message_preview: null, last_message_at: null, last_sender_name: null,
  bots: [{ ...bot, role: "owner" }],
});

beforeEach(() => {
  vi.restoreAllMocks();
  chat.getState().resetChatState();
  chat.setState({ prefetchRoomMessages });
  ui.setState(ui.getInitialState());
});

describe("owned-Bot chat entry", () => {
  it("navigates synchronously before a known room's prefetch completes, without resolving the room again", () => {
    chat.setState({ ownedAgentRooms: [ownerRoom()] });
    vi.spyOn(api, "getUserChatRoom").mockImplementation(() => new Promise(() => {}));
    const prefetch = vi.spyOn(chat.getState(), "prefetchRoomMessages").mockImplementation(() => new Promise(() => {}));
    const push = vi.fn(() => {
      expect(ui.getState()).toMatchObject({
        sidebarTab: "messages", messagesPane: "user-chat", userChatAgentId: "ag_owned",
        userChatRoomId: "rm_oc_real", focusedRoomId: null, openedRoomId: null,
      });
      expect(prefetch).not.toHaveBeenCalled();
    });
    expect(openOwnerChat(bot, push)).toBeUndefined();
    expect(push).toHaveBeenCalledWith("/chats/messages");
    expect(prefetch).toHaveBeenCalledWith("rm_oc_real");
    expect(api.getUserChatRoom).not.toHaveBeenCalled();
    expect(chat.getState().ownedAgentRooms[0].room_id).toBe("rm_oc_real");
  });

  it("opens an unknown Bot immediately and leaves its sole room lookup to message initialization", () => {
    const lookup = vi.spyOn(api, "getUserChatRoom");
    const prefetch = vi.spyOn(chat.getState(), "prefetchRoomMessages");
    ui.setState({ userChatRoomId: "rm_oc_previous", openedRoomId: "rm_other" });
    const push = vi.fn();
    openOwnerChat(bot, push);
    expect(push).toHaveBeenCalledOnce();
    expect(ui.getState()).toMatchObject({ userChatAgentId: "ag_owned", userChatRoomId: null, openedRoomId: null });
    expect(chat.getState().ownedAgentRooms[0].room_id).toBe("rm_oc_pending_ag_owned");
    expect(lookup).not.toHaveBeenCalled();
    expect(prefetch).not.toHaveBeenCalled();
  });

  it("does not prefetch provisional or differently owned rooms", () => {
    chat.setState({ ownedAgentRooms: [ownerRoom("rm_oc_pending_ag_owned"), { ...ownerRoom(), owner_id: "ag_other" }] });
    const prefetch = vi.spyOn(chat.getState(), "prefetchRoomMessages");
    openOwnerChat(bot, vi.fn());
    expect(ui.getState().userChatRoomId).toBeNull();
    expect(prefetch).not.toHaveBeenCalled();
  });

  it("cannot retarget a newer selection when the original prefetch finishes late", async () => {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    chat.setState({ ownedAgentRooms: [ownerRoom()] });
    vi.spyOn(chat.getState(), "prefetchRoomMessages").mockReturnValue(pending);
    const push = vi.fn();
    openOwnerChat(bot, push);
    openOwnerChat({ agent_id: "ag_new", display_name: "New bot" }, push);
    finish();
    await pending;
    expect(ui.getState()).toMatchObject({ userChatAgentId: "ag_new", userChatRoomId: null });
    expect(push).toHaveBeenCalledTimes(2);
  });
});
