import { describe, expect, it, vi } from "vitest";
import type { DashboardRoom } from "./types";
import { canPrefetchMessagePage, messagePrefetchCandidates, prefetchMessagePages } from "./message-prefetch";

const room = (room_id: string, overrides: Partial<DashboardRoom> = {}) => ({
  room_id, last_message_at: "2026-09-27T00:00:00Z", ...overrides,
}) as DashboardRoom;

describe("message history prefetch", () => {
  it("does not request history for optimistic room placeholders", () => {
    expect(canPrefetchMessagePage("rm_oc_pending_ag_new")).toBe(false);
    expect(messagePrefetchCandidates([room("rm_oc_pending_ag_new", { has_unread: true })])).toEqual([]);
    expect(canPrefetchMessagePage("rm_oc_real")).toBe(true);
  });
  it("includes owner chats, prioritizes unread rooms and caps speculative pages", () => {
    const rooms = [
      room("rm_empty", { last_message_at: null }),
      ...Array.from({ length: 8 }, (_, i) => room(`rm_${i}`)),
      room("rm_oc_bot", { has_unread: true }),
    ];
    const candidates = messagePrefetchCandidates(rooms);
    expect(candidates).toHaveLength(6);
    expect(candidates[0].room_id).toBe("rm_oc_bot");
    expect(candidates.some((r) => r.room_id === "rm_empty")).toBe(false);
    expect(rooms[0].room_id).toBe("rm_empty");
  });

  it("runs at most two speculative requests and stops queued work on navigation", async () => {
    const resolve: (() => void)[] = [];
    const fetch = vi.fn(() => new Promise<void>((done) => resolve.push(done)));
    const cancel = prefetchMessagePages([room("a"), room("b"), room("c"), room("d")], fetch);
    expect(fetch.mock.calls).toHaveLength(2);
    resolve[0]();
    await Promise.resolve();
    expect(fetch.mock.calls).toHaveLength(3);
    cancel();
    resolve[1]();
    resolve[2]();
    await Promise.resolve();
    expect(fetch.mock.calls).toHaveLength(3);
  });

  it("continues the queue after a failed speculative request", async () => {
    const fetch = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(undefined);
    prefetchMessagePages([room("a"), room("b"), room("c")], fetch);
    await Promise.resolve();
    await Promise.resolve();
    expect(fetch).toHaveBeenCalledWith("c");
  });
});
