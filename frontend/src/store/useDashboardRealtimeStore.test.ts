import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  refreshOverview: vi.fn(), refreshHumanRooms: vi.fn(), loadOwnedAgentRooms: vi.fn(),
  getRoomSummary: vi.fn(), bumpRoomMembersVersion: vi.fn(),
}));
vi.mock("@/lib/api", () => ({ api: {} }));
vi.mock("@/store/useDashboardChatStore", () => ({ useDashboardChatStore: { getState: () => mocks } }));
vi.mock("@/store/useDashboardSessionStore", () => ({ useDashboardSessionStore: { getState: () => ({
  token: "token", human: { human_id: "hu_1" }, activeIdentity: { type: "human" }, refreshHumanRooms: mocks.refreshHumanRooms,
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
  expect(mocks.refreshOverview).toHaveBeenCalledTimes(1);
  expect(mocks.refreshHumanRooms).toHaveBeenCalledTimes(1);
  expect(mocks.loadOwnedAgentRooms).toHaveBeenCalledTimes(1);
});
it("does not refetch directories for messages in known rooms", async () => {
  mocks.getRoomSummary.mockReturnValue({ room_id: "rm_new" });
  await useDashboardRealtimeStore.getState().syncRealtimeEvent(event);
  expect(mocks.refreshOverview).not.toHaveBeenCalled();
  expect(mocks.loadOwnedAgentRooms).not.toHaveBeenCalled();
});
it("refreshes every directory when room membership changes", async () => {
  await useDashboardRealtimeStore.getState().syncRealtimeEvent({ ...event, type: "room_member_added" });
  expect(mocks.bumpRoomMembersVersion).toHaveBeenCalledWith("rm_new");
  expect(mocks.refreshHumanRooms).toHaveBeenCalledTimes(1);
  expect(mocks.loadOwnedAgentRooms).toHaveBeenCalledTimes(1);
});
