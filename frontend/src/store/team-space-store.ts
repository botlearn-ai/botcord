/** Page-scoped Team state. A late response can never replace another space. */
import { createStore } from "zustand/vanilla";
import { ApiError, humansApi, userApi } from "@/lib/api";
import {
  teamSpacesApi,
  type SpaceMembers,
  type TeamSpace,
} from "@/lib/team-spaces";
import type { HumanInfo, UserProfile } from "@/lib/types";

export interface TeamSnapshot {
  spaces: TeamSpace[];
  selected: TeamSpace;
  members: SpaceMembers;
  user: UserProfile;
  human: HumanInfo;
}
interface TeamState {
  snapshot: TeamSnapshot | null;
  loading: boolean;
  error: unknown;
  load: (spaceId?: string | null) => Promise<void>;
  cancel: () => void;
}

export function createTeamSpaceStore(preferOrganization = false) {
  let generation = 0;
  let controller: AbortController | null = null;
  return createStore<TeamState>((set) => ({
    snapshot: null,
    loading: true,
    error: null,
    cancel: () => {
      generation += 1;
      controller?.abort();
    },
    load: async (spaceId) => {
      const current = ++generation;
      controller?.abort();
      controller = new AbortController();
      const { signal } = controller;
      set({ loading: true, error: null, snapshot: null });
      try {
        const [{ spaces }, user, human] = await Promise.all([
          teamSpacesApi.list(signal),
          userApi.getMe({ force: true }),
          humansApi.getMe(),
        ]);
        if (current !== generation) return;
        const selected = spaceId
          ? spaces.find((space) => space.id === spaceId)
          : (preferOrganization
              ? spaces.find((space) => space.kind === "organization" && space.status === "active" && space.membership.status === "active")
                ?? spaces.find((space) => space.kind === "organization" && space.status === "active" && space.membership.status === "invited")
              : undefined)
            ?? spaces.find((space) => space.kind === "personal");
        if (!selected) throw new ApiError(404, "space_not_available");
        const members =
          selected.membership.status === "active" &&
          selected.status === "active"
            ? await teamSpacesApi.members(selected.id, signal)
            : { users: [], agents: [] };
        if (current !== generation) return;
        set({
          snapshot: { spaces, selected, members, user, human },
          loading: false,
        });
      } catch (error) {
        if (current === generation)
          set({ error, loading: false, snapshot: null });
      }
    },
  }));
}
