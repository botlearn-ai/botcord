import { beforeEach, describe, expect, it, vi } from "vitest";

const requests = vi.fn();
vi.mock("@/lib/team-access", () => ({
  teamAccessApi: { requests: (...args: unknown[]) => requests(...args) },
  pendingToDecide: (r: { to_decide: unknown[] }) => r.to_decide,
}));

import { ACCESS_REQUEST_EVENT, useTeamAccessStore } from "./useTeamAccessStore";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const hint = (spaceId: string) => ({
  type: ACCESS_REQUEST_EVENT,
  ext: { space_id: spaceId, request_id: "r1", status: "pending" },
});

describe("useTeamAccessStore realtime", () => {
  beforeEach(() => {
    requests.mockReset();
    useTeamAccessStore.setState({ toDecideBySpace: {}, changesBySpace: {}, activeSpaceId: null });
  });

  it("ignores other event types", () => {
    expect(useTeamAccessStore.getState().applyRealtimeEvent({ type: "message", ext: {} })).toBe(false);
    expect(useTeamAccessStore.getState().applyRealtimeEvent(null)).toBe(false);
    expect(requests).not.toHaveBeenCalled();
  });

  it("drops hints outside Team or for another organization", () => {
    const store = useTeamAccessStore.getState();
    expect(store.applyRealtimeEvent(hint("s1"))).toBe(true);
    store.setActiveSpace("s2");
    expect(store.applyRealtimeEvent(hint("s1"))).toBe(true);
    expect(requests).not.toHaveBeenCalled();
    expect(useTeamAccessStore.getState().changesBySpace).toEqual({});
  });

  it("refetches the badge and bumps the directory counter for the open organization", async () => {
    requests.mockResolvedValue({ to_decide: [{ id: "r1" }], mine: [] });
    const store = useTeamAccessStore.getState();
    store.setActiveSpace("s1");
    store.applyRealtimeEvent(hint("s1"));
    await vi.waitFor(() => expect(useTeamAccessStore.getState().toDecideBySpace.s1).toEqual([{ id: "r1" }]));
    expect(requests).toHaveBeenCalledWith("s1", "pending");
    expect(useTeamAccessStore.getState().changesBySpace.s1).toBe(1);
  });

  it("refetches again after an in-flight load, coalescing bursts", async () => {
    const first = deferred<{ to_decide: unknown[] }>();
    requests.mockReturnValueOnce(first.promise).mockResolvedValue({ to_decide: [{ id: "new" }] });
    const store = useTeamAccessStore.getState();
    store.setActiveSpace("s1");
    void store.refreshToDecide("s1");
    // Plain refreshes share the in-flight load.
    void store.refreshToDecide("s1");
    store.applyRealtimeEvent(hint("s1"));
    store.applyRealtimeEvent(hint("s1"));
    expect(requests).toHaveBeenCalledTimes(1);
    first.resolve({ to_decide: [{ id: "stale" }] });
    await vi.waitFor(() => expect(useTeamAccessStore.getState().toDecideBySpace.s1).toEqual([{ id: "new" }]));
    expect(requests).toHaveBeenCalledTimes(2);
    expect(useTeamAccessStore.getState().changesBySpace.s1).toBe(2);
  });

  it("resync catches up only while an organization is open", async () => {
    requests.mockResolvedValue({ to_decide: [] });
    useTeamAccessStore.getState().resync();
    expect(requests).not.toHaveBeenCalled();
    useTeamAccessStore.getState().setActiveSpace("s1");
    useTeamAccessStore.getState().resync();
    await vi.waitFor(() => expect(requests).toHaveBeenCalledTimes(1));
    expect(useTeamAccessStore.getState().changesBySpace.s1).toBe(1);
  });
});
