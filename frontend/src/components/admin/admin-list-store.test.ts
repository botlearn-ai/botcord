import { expect, it, vi } from "vitest";
import { createAdminListStore } from "./admin-list-store";
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
it("keeps the loaded table visible during refresh after a mutation", async () => {
  const next = deferred<string[]>();
  const api = vi.fn().mockResolvedValueOnce(["old"]).mockReturnValueOnce(next.promise);
  const store = createAdminListStore<string>(api);
  await store.getState().load("codes");
  const refresh = store.getState().refresh();
  expect(store.getState().rows).toEqual(["old"]);
  expect(store.getState().loading).toBe(false);
  next.resolve(["old", "new"]);
  await refresh;
  expect(store.getState().rows).toEqual(["old", "new"]);
});
it("clears changed filters and ignores the older filter's late response", async () => {
  const old = deferred<string[]>();
  const current = deferred<string[]>();
  const api = vi.fn().mockResolvedValueOnce(["pending"]).mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
  const store = createAdminListStore<string>(api);
  await store.getState().load("pending");
  const refresh = store.getState().refresh();
  const load = store.getState().load("approved");
  expect(store.getState().rows).toEqual([]);
  expect(store.getState().loading).toBe(true);
  current.resolve(["approved"]);
  await load;
  old.resolve(["stale"]);
  await refresh;
  expect(store.getState().rows).toEqual(["approved"]);
  expect(store.getState().key).toBe("approved");
});
it("refreshes the current filter after a delayed mutation completes", async () => {
  const api = vi.fn().mockResolvedValue([]);
  const store = createAdminListStore<string>(api);
  await store.getState().load("pending");
  const refreshAfterMutation = store.getState().refresh;
  await store.getState().load("approved");
  await refreshAfterMutation();
  expect(api.mock.calls.map(([key]) => key)).toEqual(["pending", "approved", "approved"]);
});
it("clears retained rows when authorization revalidation fails", async () => {
  const api = vi.fn().mockResolvedValueOnce(["private"]).mockRejectedValueOnce(new Error("forbidden"));
  const store = createAdminListStore<string>(api);
  await store.getState().load("codes");
  await store.getState().refresh();
  expect(store.getState().rows).toEqual([]);
  expect(store.getState().error).toBe("forbidden");
});
it("does not update a page after it unmounts", async () => {
  const pending = deferred<string[]>();
  const store = createAdminListStore<string>(() => pending.promise);
  const loading = store.getState().load("codes");
  store.getState().cancel();
  pending.resolve(["late"]);
  await loading;
  expect(store.getState().rows).toEqual([]);
});
