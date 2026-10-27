import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  refreshOverview: vi.fn(), sync: vi.fn(),
  getRoomSummary: vi.fn(), bumpRoomMembersVersion: vi.fn(),
}));
vi.mock("./useConversationDirectoryStore", () => ({ useConversationDirectoryStore: { getState: () => ({ accountId: "account", sync: mocks.sync }) } }));
vi.mock("@/lib/api", () => ({ api: {} }));
vi.mock("@/store/useDashboardChatStore", () => ({ useDashboardChatStore: { getState: () => mocks } }));
vi.mock("@/store/useDashboardSessionStore", () => ({ useDashboardSessionStore: { getState: () => ({
  token: "token", human: { human_id: "hu_1" }, activeIdentity: { type: "human" },
}) } }));
vi.mock("@/store/useDashboardUIStore", () => ({ useDashboardUIStore: { getState: () => ({}) } }));
vi.mock("@/store/useDashboardContactStore", () => ({ useDashboardContactStore: { getState: () => ({ loadContactRequests: vi.fn() }) } }));
vi.mock("@/store/useOwnerChatStore", () => ({ useOwnerChatStore: { getState: () => ({}) } }));
import { useDashboardRealtimeStore } from "./useDashboardRealtimeStore";
import type { RealtimeMetaEvent } from "@/lib/types";
const event = { type: "message", room_id: "rm_new", ext: {} } as RealtimeMetaEvent;
beforeEach(() => { vi.clearAllMocks(); useDashboardRealtimeStore.getState().resetRealtimeState(); });
it("discovers unknown bot and human rooms immediately after a message event", async () => {
  mocks.getRoomSummary.mockReturnValue(null);
  await useDashboardRealtimeStore.getState().syncRealtimeEvent(event);
  expect(mocks.sync).toHaveBeenCalledTimes(1);
  expect(mocks.refreshOverview).not.toHaveBeenCalled();
});
it("does not refetch directories for messages in known rooms", async () => {
  mocks.getRoomSummary.mockReturnValue({ room_id: "rm_new" });
  await useDashboardRealtimeStore.getState().syncRealtimeEvent(event);
  expect(mocks.refreshOverview).not.toHaveBeenCalled();
  expect(mocks.sync).not.toHaveBeenCalled();
});
it("refreshes every directory when room membership changes", async () => {
  await useDashboardRealtimeStore.getState().syncRealtimeEvent({ ...event, type: "room_member_added" });
  expect(mocks.bumpRoomMembersVersion).toHaveBeenCalledWith("rm_new");
  expect(mocks.sync).toHaveBeenCalledTimes(1);
});
