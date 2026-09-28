import { beforeEach, describe, expect, it, vi } from "vitest";

const openDmRoom = vi.fn(async () => ({ room_id: "rm_dm_ag_barry_hu_alice" }));
const ui = {
  setMessagesPane: vi.fn(),
  setUserChatAgentId: vi.fn(),
  setFocusedRoomId: vi.fn(),
  setOpenedRoomId: vi.fn(),
  startPrimaryNavigation: vi.fn(),
};
const loadRoomMessages = vi.fn(async () => {});

vi.mock("@/lib/api", () => ({ api: { openDmRoom } }));
vi.mock("@/store/useDashboardUIStore", () => ({ useDashboardUIStore: { getState: () => ui } }));
vi.mock("@/store/useDashboardSessionStore", () => ({
  useDashboardSessionStore: { getState: () => ({ refreshHumanRooms: async () => {} }) },
}));
vi.mock("@/store/useDashboardChatStore", () => ({
  useDashboardChatStore: { getState: () => ({ refreshOverview: async () => {}, loadRoomMessages }) },
}));

const { openSharedAgentChat } = await import("./shared-agent-chat");

describe("openSharedAgentChat", () => {
  beforeEach(() => vi.clearAllMocks());

  it("opens the DM and navigates to a URL that carries the room id", async () => {
    const push = vi.fn();
    const roomId = await openSharedAgentChat("ag_barry", push);

    expect(openDmRoom).toHaveBeenCalledWith("ag_barry");
    expect(roomId).toBe("rm_dm_ag_barry_hu_alice");
    expect(ui.setOpenedRoomId).toHaveBeenCalledWith(roomId);
    expect(push).toHaveBeenCalledWith("/chats/messages/rm_dm_ag_barry_hu_alice");
    expect(ui.startPrimaryNavigation).toHaveBeenCalledWith("messages", "/chats/messages/rm_dm_ag_barry_hu_alice");
    expect(loadRoomMessages).toHaveBeenCalledWith(roomId);
  });
});
