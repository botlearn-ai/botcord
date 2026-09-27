import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PublicRoomMessagePreviewResponse } from "@/lib/types";

const api = vi.hoisted(() => ({
  getPublicRoomMessagePreviews: vi.fn(),
  getRoomMessages: vi.fn(),
}));
vi.mock("@/lib/api", () => ({
  api,
  ApiError: class extends Error {
    constructor(public status: number, message: string) { super(message); }
  },
}));
import { ApiError } from "@/lib/api";
let getStore: typeof import("./paid-room-preview-cache").getPaidRoomPreviewStore;

const response = (text: string): PublicRoomMessagePreviewResponse => ({
  messages: [{ hub_msg_id: text, sender_id: "sender", sender_name: "Sender", preview: text, created_at: null }],
});
function deferred() {
  let resolve!: (value: PublicRoomMessagePreviewResponse) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<PublicRoomMessagePreviewResponse>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
beforeEach(async () => {
  vi.resetModules();
  vi.resetAllMocks();
  ({ getPaidRoomPreviewStore: getStore } = await import("./paid-room-preview-cache"));
});
afterEach(() => vi.restoreAllMocks());

it("shows warm previews while refreshing and coalesces concurrent entry requests", async () => {
  api.getPublicRoomMessagePreviews.mockResolvedValueOnce(response("cached"));
  const store = getStore("room", "product");
  await store.getState().load();
  const refresh = deferred();
  api.getPublicRoomMessagePreviews.mockReturnValueOnce(refresh.promise);
  const revisited = getStore("room", "product");
  const first = revisited.getState().load();
  const second = revisited.getState().load();
  expect(second).toBe(first);
  expect(revisited).toBe(store);
  expect(revisited.getState().messages?.[0].preview).toBe("cached");
  expect(revisited.getState().loading).toBe(false);
  expect(api.getPublicRoomMessagePreviews).toHaveBeenCalledTimes(2);
  refresh.resolve(response("fresh"));
  await first;
  expect(store.getState().messages?.[0].preview).toBe("fresh");
  expect(api.getRoomMessages).not.toHaveBeenCalled();
});

it("treats a cached empty result as loaded content during revalidation", async () => {
  api.getPublicRoomMessagePreviews.mockResolvedValueOnce({ messages: [] });
  const store = getStore("empty", "product");
  await store.getState().load();
  const refresh = deferred();
  api.getPublicRoomMessagePreviews.mockReturnValueOnce(refresh.promise);
  const task = getStore("empty", "product").getState().load();
  expect(store.getState().messages).toEqual([]);
  expect(store.getState().loading).toBe(false);
  refresh.resolve({ messages: [] });
  await task;
});

it("isolates rapid room changes and subscription-product changes", async () => {
  const old = deferred();
  api.getPublicRoomMessagePreviews.mockReturnValueOnce(old.promise).mockResolvedValueOnce(response("new"));
  const first = getStore("old-room", "product");
  const firstLoad = first.getState().load();
  const second = getStore("new-room", "product");
  expect(second.getState().messages).toBeNull();
  await second.getState().load();
  old.resolve(response("old"));
  await firstLoad;
  expect(second.getState().messages?.[0].preview).toBe("new");
  expect(getStore("new-room", "different-product").getState().messages).toBeNull();
});

it("clears cached previews on revalidation failure and allows an explicit retry", async () => {
  api.getPublicRoomMessagePreviews.mockResolvedValueOnce(response("public"))
    .mockRejectedValueOnce(new ApiError(403, "Room is not public"))
    .mockResolvedValueOnce(response("available again"));
  const store = getStore("room", "product");
  await store.getState().load();
  await store.getState().load();
  expect(store.getState().messages).toBeNull();
  expect(store.getState().loading).toBe(false);
  expect(store.getState().error).toBeInstanceOf(Error);
  await store.getState().load();
  expect(store.getState().error).toBeNull();
  expect(store.getState().messages?.[0].preview).toBe("available again");
});

it("starts cold immediately and never keeps more than three public summaries", async () => {
  api.getPublicRoomMessagePreviews.mockResolvedValue({ messages: [
    ...response("one").messages, ...response("two").messages,
    ...response("three").messages, ...response("extra").messages,
  ] });
  const store = getStore("room", "product");
  expect(store.getState().loading).toBe(true);
  await store.getState().load();
  expect(store.getState().messages?.map((message) => message.preview)).toEqual(["one", "two", "three"]);
  expect(api.getRoomMessages).not.toHaveBeenCalled();
});

it("expires old summaries instead of painting them after a long absence", async () => {
  const now = vi.spyOn(Date, "now").mockReturnValue(10_000);
  api.getPublicRoomMessagePreviews.mockResolvedValue(response("expired"));
  const old = getStore("room", "product");
  await old.getState().load();
  now.mockReturnValue(70_001);
  const current = getStore("room", "product");
  expect(current).not.toBe(old);
  expect(current.getState().messages).toBeNull();
  expect(current.getState().loading).toBe(true);
});

it("bounds the cache and does not restore evicted entries from late responses", async () => {
  const pending = deferred();
  api.getPublicRoomMessagePreviews.mockReturnValueOnce(pending.promise);
  const oldest = getStore("oldest", "product");
  const load = oldest.getState().load();
  for (let i = 0; i < 32; i++) getStore(String(i), "product");
  pending.resolve(response("evicted"));
  await load;
  const revisited = getStore("oldest", "product");
  expect(revisited).not.toBe(oldest);
  expect(revisited.getState().messages).toBeNull();
});

it("retains a fresh public summary during a transient failure and clears it once expired", async () => {
  const now = vi.spyOn(Date, "now").mockReturnValue(10_000);
  api.getPublicRoomMessagePreviews.mockResolvedValueOnce(response("public"))
    .mockRejectedValueOnce(new Error("offline"))
    .mockRejectedValueOnce(new ApiError(503, "unavailable"));
  const store = getStore("room", "product");
  await store.getState().load();
  await store.getState().load();
  expect(store.getState().messages?.[0].preview).toBe("public");
  expect(store.getState().error).toBeInstanceOf(Error);
  now.mockReturnValue(70_001);
  await store.getState().load();
  expect(store.getState().messages).toBeNull();
});
