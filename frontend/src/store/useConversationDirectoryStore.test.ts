// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";
import type { ConversationSyncResponse, DashboardRoom, RealtimeMetaEvent } from "@/lib/types";
const mocks = vi.hoisted(() => ({ sync: vi.fn() }));
vi.mock("@/lib/api", () => ({ api: { syncConversations: mocks.sync } }));
import { useConversationDirectoryStore as store } from "./useConversationDirectoryStore";
const room = (id: string, revision = "v1", time = "2026-01-01T00:00:00Z"): DashboardRoom => ({
  room_id: id, name: id, description: "", owner_id: "hu_a", visibility: "private", member_count: 2,
  my_role: "member", rule: null, has_unread: false, last_message_at: time, last_message_preview: revision,
  last_sender_name: "Sender", revision,
});
const response = (rooms: DashboardRoom[], extra: Partial<ConversationSyncResponse> = {}): ConversationSyncResponse => ({
  next_cursor: "cursor-1", reset: false, account_id: "a", human_id: "hu_a", upserts: rooms, removed_ids: [], has_more: false, ...extra,
});
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; }
beforeEach(() => { store.getState().activate(null, true); localStorage.clear(); vi.clearAllMocks(); store.getState().activate("a"); });

it("restores the full directory synchronously without waiting for the network", async () => {
  mocks.sync.mockResolvedValue(response([room("latest"), room("old", "v1", "2025-01-01T00:00:00Z")]));
  await store.getState().sync();
  store.getState().setView({ filter: "bots-all", botScope: "ag_two" });
  store.getState().activate(null);
  store.getState().activate("a");
  expect(store.getState().rooms.map((r) => r.room_id)).toEqual(["latest", "old"]);
  expect(store.getState().view.botScope).toBe("ag_two");
  expect(store.getState().ready).toBe(true);
  const request = deferred<ConversationSyncResponse>(); mocks.sync.mockReturnValue(request.promise);
  const pending = store.getState().sync();
  expect(store.getState().rooms).toHaveLength(2);
  request.resolve(response([])); await pending;
  expect(mocks.sync).toHaveBeenLastCalledWith("cursor-1");
});

it("merges updates and removals without dropping unchanged rooms", async () => {
  mocks.sync.mockResolvedValueOnce(response([room("old"), room("kept"), room("removed")]));
  await store.getState().sync();
  mocks.sync.mockResolvedValueOnce(response([room("old", "v2", "2026-02-01T00:00:00Z")], { removed_ids: ["removed"] }));
  await store.getState().sync();
  expect(store.getState().rooms.map((r) => [r.room_id, r.revision])).toEqual([["old", "v2"], ["kept", "v1"]]);
});

it("renders the first batch while subsequent pages are pending", async () => {
  const later = deferred<ConversationSyncResponse>();
  mocks.sync.mockResolvedValueOnce(response([room("newest")], { has_more: true })).mockReturnValueOnce(later.promise);
  const sync = store.getState().sync();
  await vi.waitFor(() => expect(mocks.sync).toHaveBeenCalledTimes(2));
  expect(store.getState().rooms[0].room_id).toBe("newest");
  expect(store.getState().syncing).toBe(true);
  expect(mocks.sync).toHaveBeenLastCalledWith("cursor-1");
  later.resolve(response([room("older", "v1", "2025-01-01T00:00:00Z")])); await sync;
  expect(store.getState().rooms).toHaveLength(2);
});

it("keeps cached rows during offline/failure and recovers on a later sync", async () => {
  mocks.sync.mockResolvedValueOnce(response([room("saved")])); await store.getState().sync();
  mocks.sync.mockRejectedValueOnce(new Error("offline")); await store.getState().sync();
  expect(store.getState().rooms[0].room_id).toBe("saved");
  expect(store.getState().error).toBe("offline");
  mocks.sync.mockResolvedValueOnce(response([room("saved", "v2")])); await store.getState().sync();
  expect(store.getState().error).toBeNull();
  expect(store.getState().rooms[0].revision).toBe("v2");
});

it("fences late responses and isolates cached accounts, deleting the current cache on logout", async () => {
  mocks.sync.mockResolvedValueOnce(response([room("private-a")])); await store.getState().sync();
  const delayed = deferred<ConversationSyncResponse>(); mocks.sync.mockReturnValueOnce(delayed.promise);
  const pending = store.getState().sync();
  store.getState().activate("b");
  expect(store.getState().rooms).toEqual([]);
  delayed.resolve(response([room("late-a")])); await pending;
  expect(store.getState().rooms).toEqual([]);
  store.getState().activate("a"); expect(store.getState().rooms[0].room_id).toBe("private-a");
  store.getState().activate(null, true);
  store.getState().activate("a"); expect(store.getState().rooms).toEqual([]);
});

it("does not let an older in-flight response overwrite a realtime summary", async () => {
  mocks.sync.mockResolvedValueOnce(response([room("live")])); await store.getState().sync();
  const delayed = deferred<ConversationSyncResponse>();
  mocks.sync.mockReturnValueOnce(delayed.promise).mockResolvedValueOnce(response([room("live", "v3", "2026-03-01T00:00:00Z")]));
  const pending = store.getState().sync();
  store.getState().patch("live", { last_message_at: "2026-03-01T00:00:00Z", last_message_preview: "new" });
  delayed.resolve(response([room("live", "v2")])); await pending;
  expect(store.getState().rooms[0].revision).toBe("v3");
  expect(mocks.sync).toHaveBeenLastCalledWith("cursor-1");
});

it("ignores typing and delivery receipts, rejects stale message patches", async () => {
  mocks.sync.mockResolvedValueOnce(response([room("live")])); await store.getState().sync();
  for (const type of ["typing", "ack", "result", "error", "message_status_reaction"]) {
    store.getState().onEvent({ type, room_id: "live", created_at: "2027-01-01T00:00:00Z", ext: { preview: "wrong" } } as RealtimeMetaEvent);
  }
  store.getState().patch("live", { last_message_at: "2025-01-01T00:00:00Z", last_message_preview: "stale" });
  expect(store.getState().rooms[0].last_message_preview).toBe("v1");
  expect(mocks.sync).toHaveBeenCalledTimes(1);
});

it("handles corrupt cache and disabled storage without breaking chat", async () => {
  mocks.sync.mockResolvedValue(response([room("saved")])); await store.getState().sync();
  store.getState().activate(null);
  for (let i = 0; i < localStorage.length; i++) localStorage.setItem(localStorage.key(i)!, "broken");
  store.getState().activate("a"); expect(store.getState().rooms).toEqual([]);
  const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
  mocks.sync.mockResolvedValue(response([room("still-visible")])); await store.getState().sync();
  expect(store.getState().rooms[0].room_id).toBe("still-visible");
  write.mockRestore();
});

it("replaces obsolete cached rows when the server resets an expired cursor", async () => {
  mocks.sync.mockResolvedValueOnce(response([room("removed"), room("kept")])); await store.getState().sync();
  mocks.sync.mockResolvedValueOnce(response([room("kept", "v2")], { reset: true, next_cursor: "new-epoch" }));
  await store.getState().sync();
  expect(store.getState().rooms.map((r) => r.room_id)).toEqual(["kept"]);
  store.getState().activate(null); store.getState().activate("a");
  expect(store.getState().cursor).toBe("new-epoch");
});

it("replays a raced page instead of advancing past a skipped authoritative upsert", async () => {
  mocks.sync.mockResolvedValueOnce(response([room("live")], { next_cursor: "before" })); await store.getState().sync();
  const delayed = deferred<ConversationSyncResponse>();
  mocks.sync.mockReturnValueOnce(delayed.promise).mockResolvedValueOnce(response([room("live", "v3")], { next_cursor: "after" }));
  const pending = store.getState().sync();
  store.getState().patch("live", { last_message_preview: "local" });
  delayed.resolve(response([room("live", "v2")], { next_cursor: "after" })); await pending;
  expect(mocks.sync.mock.calls.slice(-2).map((args) => args[0])).toEqual(["before", "before"]);
  expect(store.getState().cursor).toBe("after");
});
