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
});
