// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ me: vi.fn(), human: vi.fn(), rooms: vi.fn() }));
vi.mock("@/lib/api", async (original) => {
  const actual = await original<typeof import("@/lib/api")>();
  return { ...actual, userApi: { ...actual.userApi, getMe: mocks.me }, humansApi: { ...actual.humansApi, createOrGet: mocks.human, listRooms: mocks.rooms } };
});
import { useDashboardSessionStore as session } from "./useDashboardSessionStore";
import { useConversationDirectoryStore as directory } from "./useConversationDirectoryStore";
function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; }
beforeEach(() => { session.getState().logout(); vi.clearAllMocks(); mocks.me.mockResolvedValue({ id: "account-a", agents: [] }); mocks.human.mockResolvedValue({ human_id: "hu_a" }); });
it("finishes authentication without waiting for legacy membership loading", async () => {
  const pending = deferred<{ rooms: [] }>(); mocks.rooms.mockReturnValue(pending.promise);
  await session.getState().initAuth("token-a");
  expect(session.getState().authResolved).toBe(true);
  expect(session.getState().human?.human_id).toBe("hu_a");
  expect(mocks.rooms).toHaveBeenCalledTimes(1);
  pending.resolve({ rooms: [] }); await session.getState().refreshHumanRooms();
});
it("does not reuse or apply membership requests from another account", async () => {
  const old = deferred<{ rooms: { room_id: string }[] }>(); mocks.rooms.mockReturnValueOnce(old.promise);
  await session.getState().initAuth("token-a");
  session.getState().logout();
  mocks.me.mockResolvedValue({ id: "account-b", agents: [] }); mocks.human.mockResolvedValue({ human_id: "hu_b" }); mocks.rooms.mockResolvedValue({ rooms: [{ room_id: "new" }] });
  await session.getState().initAuth("token-b"); await session.getState().refreshHumanRooms();
  old.resolve({ rooms: [{ room_id: "old" }] }); await Promise.resolve();
  expect(session.getState().humanRooms.map((room) => room.room_id)).toEqual(["new"]);
});
it("clears the conversation directory synchronously on logout", () => {
  directory.getState().activate("account-a"); directory.setState({ ready: true });
  session.getState().logout();
  expect(directory.getState().accountId).toBeNull();
  expect(directory.getState().rooms).toEqual([]);
});
