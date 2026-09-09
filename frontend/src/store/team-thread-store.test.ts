import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import {
  teamConversationsApi,
  type TeamMessage,
  type TeamMessagePage,
} from "@/lib/team-conversations";
import { createTeamThreadStore } from "./team-thread-store";
vi.mock("@/lib/team-conversations", () => ({
  teamConversationsApi: { messages: vi.fn() },
}));
const message = (sequence: number) =>
  ({ sequence, content: `Message ${sequence}` } as TeamMessage);
const page = (sequences: number[], has_more = false): TeamMessagePage => ({
  messages: sequences.map(message),
  has_more,
  last_sequence: sequences.at(-1) ?? 0,
});
const deferred = () => {
  let resolve!: (value: TeamMessagePage) => void;
  const promise = new Promise<TeamMessagePage>((done) => {
    resolve = done;
  });
  return { resolve, promise };
};
beforeEach(() => vi.resetAllMocks());
describe("Organization thread lifecycle", () => {
  it("discards an initial response after leaving the conversation", async () => {
    const response = deferred();
    vi.mocked(teamConversationsApi.messages).mockReturnValue(response.promise);
    const store = createTeamThreadStore("space-a", "room-a");
    const load = store.getState().load();
    store.getState().cancel();
    response.resolve(page([1]));
    await load;
    expect(store.getState().messages).toEqual([]);
  });
  it("drains incremental pages without skipping messages around our own send", async () => {
    const api = vi.mocked(teamConversationsApi.messages);
    api
      .mockResolvedValueOnce(page([1, 2]))
      .mockResolvedValueOnce(page([3, 4], true))
      .mockResolvedValueOnce(page([5]));
    const store = createTeamThreadStore("space-a", "room-a");
    await store.getState().load();
    await store.getState().refresh();
    expect(store.getState().messages.map((m) => m.sequence)).toEqual([
      1, 2, 3, 4, 5,
    ]);
    expect(
      api.mock.calls.map(([space, room, cursor]) => [space, room, cursor])
    ).toEqual([
      ["space-a", "room-a", {}],
      ["space-a", "room-a", { after: 2 }],
      ["space-a", "room-a", { after: 4 }],
    ]);
  });
  it("preserves concurrent older-page and new-message loads", async () => {
    const api = vi.mocked(teamConversationsApi.messages);
    const earlier = deferred();
    api
      .mockResolvedValueOnce(page([3, 4], true))
      .mockReturnValueOnce(earlier.promise)
      .mockResolvedValueOnce(page([5]));
    const store = createTeamThreadStore("space", "room");
    await store.getState().load();
    const loadOlder = store.getState().older();
    await store.getState().refresh();
    earlier.resolve(page([1, 2]));
    await loadOlder;
    expect(store.getState().messages.map((m) => m.sequence)).toEqual([
      1, 2, 3, 4, 5,
    ]);
    expect(store.getState().hasOlder).toBe(false);
  });
  it("coalesces polling and clears history when authorization revalidation fails", async () => {
    const api = vi.mocked(teamConversationsApi.messages);
    api
      .mockResolvedValueOnce(page([1]))
      .mockRejectedValueOnce(new ApiError(404, "conversation_not_available"));
    const store = createTeamThreadStore("space", "room");
    await store.getState().load();
    await Promise.all([store.getState().refresh(), store.getState().refresh()]);
    expect(api).toHaveBeenCalledTimes(2);
    expect(store.getState().messages).toEqual([]);
    expect(store.getState().error).toBeInstanceOf(ApiError);
  });
  it("ignores a stale refresh after retrying the initial load", async () => {
    const pending = deferred();
    const api = vi.mocked(teamConversationsApi.messages);
    api
      .mockResolvedValueOnce(page([1]))
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce(page([8]));
    const store = createTeamThreadStore("space", "room");
    await store.getState().load();
    const refresh = store.getState().refresh();
    await store.getState().load();
    pending.resolve(page([2]));
    await refresh;
    expect(store.getState().messages.map((m) => m.sequence)).toEqual([8]);
  });
});

it("does not restore history from a poll after an older-page permission failure", async () => {
  const api = vi.mocked(teamConversationsApi.messages);
  const polling = deferred();
  api.mockResolvedValueOnce(page([3, 4], true))
    .mockReturnValueOnce(polling.promise)
    .mockRejectedValueOnce(new ApiError(404, "conversation_not_available"));
  const store = createTeamThreadStore("space", "room");
  await store.getState().load();
  const refresh = store.getState().refresh();
  await store.getState().older();
  polling.resolve(page([5]));
  await refresh;
  expect(store.getState().messages).toEqual([]);
  expect(store.getState().error).toBeInstanceOf(ApiError);
});
