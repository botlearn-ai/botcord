/**
 * [INPUT]: zustand; lib/team-access requests endpoint
 * [OUTPUT]: useTeamAccessStore — pending access requests the viewer must decide, per organization
 * [POS]: feeds the Team nav badge and refreshes after approve/reject in any inbox
 * [PROTOCOL]: update header on changes
 */
import { create } from "zustand";
import { pendingToDecide, teamAccessApi, type AccessRequest } from "@/lib/team-access";

interface TeamAccessState {
  toDecideBySpace: Record<string, AccessRequest[]>;
  refreshToDecide: (spaceId: string) => Promise<void>;
}

const inflight = new Map<string, Promise<void>>();

export const useTeamAccessStore = create<TeamAccessState>((set) => ({
  toDecideBySpace: {},
  refreshToDecide(spaceId) {
    const pending = inflight.get(spaceId);
    if (pending) return pending;
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
  },
}));

const EMPTY: AccessRequest[] = [];
export function useToDecide(spaceId: string): AccessRequest[] {
  return useTeamAccessStore((s) => s.toDecideBySpace[spaceId] ?? EMPTY);
}
