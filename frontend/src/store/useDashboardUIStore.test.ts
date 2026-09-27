import { beforeEach, describe, expect, it } from "vitest";
import { useDashboardUIStore } from "@/store/useDashboardUIStore";

describe("useDashboardUIStore", () => {
  beforeEach(() => {
    useDashboardUIStore.getState().logout();
  });

  it("resets message grouping when opening a normal room from discovery", () => {
    const store = useDashboardUIStore.getState();

    store.setMessagesFilter("bots-group");
    store.setMessagesScope({ type: "agent", id: "ag_owned" });
    store.setMessagesBotScope("ag_owned");

    useDashboardUIStore.getState().resetMessagesGroupingForRoomOpen();

    expect(useDashboardUIStore.getState().messagesFilter).toBe("self-all");
    expect(useDashboardUIStore.getState().messagesScope).toEqual({ type: "human" });
    expect(useDashboardUIStore.getState().messagesBotScope).toBe("all");
  });

  it("does not let an older navigation completion clear a newer pending tab", () => {
    const store = useDashboardUIStore.getState();
    store.startPrimaryNavigation("home", "/chats/home");
    const first = useDashboardUIStore.getState().pendingPrimaryNavigation;
    store.startPrimaryNavigation("wallet", "/chats/wallet");
    const second = useDashboardUIStore.getState().pendingPrimaryNavigation;

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    store.clearPrimaryNavigation(first!.id);

    expect(useDashboardUIStore.getState().pendingPrimaryNavigation?.id).toBe(second!.id);
    store.clearPrimaryNavigation(second!.id);
    expect(useDashboardUIStore.getState().pendingPrimaryNavigation).toBeNull();
  });
});

describe("return to the mobile message list", () => {
  it.each(["room", "user-chat"] as const)("exits %s and closes overlays atomically", (messagesPane) => {
    useDashboardUIStore.setState({ messagesPane, openedRoomId: "rm_test", focusedRoomId: "rm_test", messagesShowRequests: true, mobileSidebarOpen: true, sidebarTab: "contacts" });
    useDashboardUIStore.getState().returnToMessageList();
    expect(useDashboardUIStore.getState()).toMatchObject({ sidebarTab: "messages", messagesPane: "room", openedRoomId: null, focusedRoomId: null, messagesShowRequests: false, mobileSidebarOpen: false, pendingPrimaryNavigation: { tab: "messages", path: "/chats/messages" } });
  });
  it("protects the return action from the old route while navigation is pending", () => {
    useDashboardUIStore.getState().startPrimaryNavigation("messages", "/chats/messages/rm_test");
    const oldId = useDashboardUIStore.getState().pendingPrimaryNavigation!.id;
    useDashboardUIStore.getState().returnToMessageList();
    useDashboardUIStore.getState().clearPrimaryNavigation(oldId);
    expect(useDashboardUIStore.getState().pendingPrimaryNavigation?.path).toBe("/chats/messages");
  });
});
