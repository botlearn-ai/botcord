import { beforeEach, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  lookup: vi.fn(),
  cached: vi.fn(),
  owner: "first",
  changed: () => {},
}));
vi.mock("./api", () => ({ api: { getUserChatRoom: fixture.lookup } }));
vi.mock("@/store/useOwnerChatStore", () => ({ findCachedOwnerChatRoom: fixture.cached }));
vi.mock("@/store/useDashboardChatStore", () => ({ messageCacheOwnerKey: () => fixture.owner }));
vi.mock("@/store/useDashboardSessionStore", () => ({
  useDashboardSessionStore: { subscribe: (changed: () => void) => { fixture.changed = changed; } },
}));
import { resolveOwnerChatRoom } from "./owner-chat-room";

beforeEach(() => {
  fixture.owner += "next";
  fixture.changed();
  fixture.lookup.mockReset();
  fixture.cached.mockReset();
});

it("uses a verified known room without another lookup", async () => {
  fixture.cached.mockReturnValue({ room_id: "rm_oc_known", name: "Known" });
  await expect(resolveOwnerChatRoom("ag_1")).resolves.toMatchObject({ room_id: "rm_oc_known" });
  expect(fixture.lookup).not.toHaveBeenCalled();
});

it("shares shell and detail discovery, but not discovery for another Bot", async () => {
  let finish!: (room: { room_id: string; name: string }) => void;
  fixture.lookup.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  const first = resolveOwnerChatRoom("ag_1");
  const second = resolveOwnerChatRoom("ag_1");
  expect(second).toBe(first);
  await Promise.resolve();
  expect(fixture.lookup).toHaveBeenCalledTimes(1);
  finish({ room_id: "rm_oc_1", name: "One" });
  await first;
  fixture.lookup.mockResolvedValue({ room_id: "rm_oc_2", name: "Two" });
  await expect(resolveOwnerChatRoom("ag_2")).resolves.toMatchObject({ room_id: "rm_oc_2" });
});

it("allows a failed lookup to be retried", async () => {
  fixture.lookup.mockRejectedValueOnce(new Error("offline"));
  await expect(resolveOwnerChatRoom("ag_1")).rejects.toThrow("offline");
  fixture.lookup.mockResolvedValue({ room_id: "rm_oc_1", name: "One" });
  await expect(resolveOwnerChatRoom("ag_1")).resolves.toMatchObject({ room_id: "rm_oc_1" });
  expect(fixture.lookup).toHaveBeenCalledTimes(2);
});

it("does not join a previous account's unresolved discovery", async () => {
  let finishOld!: (room: { room_id: string; name: string }) => void;
  fixture.lookup.mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; }));
  const old = resolveOwnerChatRoom("ag_1");
  await Promise.resolve();
  fixture.owner = "other";
  fixture.changed();
  fixture.lookup.mockResolvedValue({ room_id: "rm_oc_new", name: "New" });
  const fresh = resolveOwnerChatRoom("ag_1");
  expect(fresh).not.toBe(old);
  finishOld({ room_id: "rm_oc_old", name: "Old" });
  await old;
  await expect(fresh).resolves.toMatchObject({ room_id: "rm_oc_new" });
});

it("does not start a queued lookup after the account changes", async () => {
  const request = resolveOwnerChatRoom("ag_1");
  fixture.owner = "signed-out";
  fixture.changed();
  await expect(request).rejects.toThrow("Chat session changed");
  expect(fixture.lookup).not.toHaveBeenCalled();
});
