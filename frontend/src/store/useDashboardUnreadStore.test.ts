// @vitest-environment jsdom
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { useDashboardUnreadStore as unread } from "./useDashboardUnreadStore";
import { useConversationDirectoryStore as directory } from "./useConversationDirectoryStore";
import { api } from "@/lib/api";
import type { DashboardRoom, RealtimeMetaEvent } from "@/lib/types";
let finish: (value: { room_id: string; last_viewed_at: string }) => void;
let fail: (error: Error) => void;
const message = { type: "message", room_id: "r" } as RealtimeMetaEvent;
beforeEach(() => {
  unread.getState().resetUnreadState();
  directory.getState().activate("test-account", true);
  vi.spyOn(directory.getState(), "sync").mockResolvedValue();
  vi.spyOn(directory.getState(), "patch");
  vi.spyOn(api, "markRoomRead").mockImplementation(() => new Promise((resolve, reject) => { finish = resolve; fail = reject; }));
});
afterEach(() => vi.restoreAllMocks());
it("deduplicates pending clicks and keeps optimistic read during stale reconciliation", async () => {
  const request = unread.getState().markRoomRead("r");
  await unread.getState().markRoomRead("r");
  unread.getState().reconcileUnreadRooms([{ room_id: "r", has_unread: false } as DashboardRoom]);
  expect(unread.getState().isRoomUnread("r", true)).toBe(false);
  expect(api.markRoomRead).toHaveBeenCalledTimes(1);
  finish({ room_id: "r", last_viewed_at: "now" }); await request;
  expect(directory.getState().patch).toHaveBeenCalledWith("r", { has_unread: false, unread_count: 0 });
  expect(unread.getState().pendingReadRoomIds).toEqual([]);
});
it.each([true, false])("preserves a new message when the old read request settles (success=%s)", async (success) => {
  const request = unread.getState().markRoomRead("r");
  unread.getState().applyRealtimeEvent(message);
  if (success) finish({ room_id: "r", last_viewed_at: "now" }); else fail(new Error("offline"));
  await request;
  expect(unread.getState().isRoomUnread("r", false)).toBe(true);
  expect(directory.getState().patch).not.toHaveBeenCalled();
});
it.each([true, false])("ignores a stale completion after logout (success=%s)", async (success) => {
  const request = unread.getState().markRoomRead("r");
  unread.getState().logout(); directory.getState().activate("other-account");
  if (success) finish({ room_id: "r", last_viewed_at: "now" }); else fail(new Error("offline"));
  await request;
  expect(unread.getState().optimisticSeenRoomIds).toEqual([]);
  expect(unread.getState().optimisticUnreadRoomIds).toEqual([]);
  expect(directory.getState().patch).not.toHaveBeenCalled();
});
it("does not undo a newer automatic read on failure", async () => {
  const request = unread.getState().markRoomRead("r");
  await unread.getState().markRoomSeen("r", null);
  fail(new Error("offline")); await request;
  expect(unread.getState().isRoomUnread("r", true)).toBe(false);
});
