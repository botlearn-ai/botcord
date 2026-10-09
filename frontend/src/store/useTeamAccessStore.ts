/**
 * [INPUT]: zustand; lib/team-access requests endpoint; `access_request_changed` realtime hints (human channel)
 * [OUTPUT]: useTeamAccessStore — pending access requests the viewer must decide, per organization, plus a
 *           per-organization change counter that the directory watches to refetch
 * [POS]: feeds the Team nav badge and inbox; DashboardApp forwards realtime hints, TeamWorkspacePage marks
 *        which organization is open so hints for other organizations (or outside Team) are ignored
 * [PROTOCOL]: update header on changes
 */
import { create } from "zustand";
import { pendingToDecide, teamAccessApi, type AccessRequest } from "@/lib/team-access";

export const ACCESS_REQUEST_EVENT = "access_request_changed";

interface TeamAccessState {
  toDecideBySpace: Record<string, AccessRequest[]>;
  /** Bumped when requests or grants in an organization changed elsewhere. */
  changesBySpace: Record<string, number>;
  /** Organization open in Team mode; null outside Team. */
  activeSpaceId: string | null;
  /** `force` refetches even when a load is in flight (it may predate the change). */
  refreshToDecide: (spaceId: string, opts?: { force?: boolean }) => Promise<void>;
  setActiveSpace: (spaceId: string | null) => void;
  /** Handle a realtime event; returns true when it was an access-request hint. */
  applyRealtimeEvent: (event: { type?: string; ext?: Record<string, unknown> } | null | undefined) => boolean;
  /** Catch up after a reconnect or when the tab becomes visible again. */
  resync: () => void;
}

const inflight = new Map<string, Promise<void>>();
const queued = new Map<string, Promise<void>>();

export const useTeamAccessStore = create<TeamAccessState>((set, get) => {
  function load(spaceId: string): Promise<void> {
    const task = teamAccessApi
      .requests(spaceId, "pending")
      .then((requests) =>
        set((s) => ({
          toDecideBySpace: { ...s.toDecideBySpace, [spaceId]: pendingToDecide(requests) },
        })),
      )
      // The badge is advisory; the inbox itself reports load errors.
      .catch(() => undefined)
      .finally(() => inflight.delete(spaceId));
    inflight.set(spaceId, task);
    return task;
  }

  function changed(spaceId: string) {
    set((s) => ({
      changesBySpace: { ...s.changesBySpace, [spaceId]: (s.changesBySpace[spaceId] ?? 0) + 1 },
    }));
    void get().refreshToDecide(spaceId, { force: true });
  }

  return {
    toDecideBySpace: {},
    changesBySpace: {},
    activeSpaceId: null,
    refreshToDecide(spaceId, opts) {
      const running = inflight.get(spaceId);
      if (!running) return load(spaceId);
      if (!opts?.force) return running;
      // One follow-up load covers any number of changes during the current one.
      const waiting = queued.get(spaceId);
      if (waiting) return waiting;
      const next = running.then(() => {
        queued.delete(spaceId);
        return load(spaceId);
      });
      queued.set(spaceId, next);
      return next;
    },
    setActiveSpace(spaceId) {
      set({ activeSpaceId: spaceId });
    },
    applyRealtimeEvent(event) {
      if (event?.type !== ACCESS_REQUEST_EVENT) return false;
      const spaceId = event.ext?.space_id;
      if (typeof spaceId === "string" && spaceId === get().activeSpaceId) changed(spaceId);
      return true;
    },
    resync() {
      const spaceId = get().activeSpaceId;
      if (spaceId) changed(spaceId);
    },
  };
});

const EMPTY: AccessRequest[] = [];
export function useToDecide(spaceId: string): AccessRequest[] {
  return useTeamAccessStore((s) => s.toDecideBySpace[spaceId] ?? EMPTY);
}

export function useAccessChanges(spaceId: string): number {
  return useTeamAccessStore((s) => s.changesBySpace[spaceId] ?? 0);
}
