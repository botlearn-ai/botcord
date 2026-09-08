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
  refreshing: boolean;
  error: unknown;
  load: (spaceId?: string | null, options?: { background?: boolean }) => Promise<void>;
  refresh: (spaceId?: string | null) => Promise<void>;
  cancel: () => void;
}

export function createTeamSpaceStore(preferOrganization = false) {
  let generation = 0;
  let controller: AbortController | null = null;
  let lastStartedAt = 0;
  let lastSpaceId: string | null = null;
  return createStore<TeamState>((set, get) => ({
    snapshot: null,
    loading: true,
    refreshing: false,
    error: null,
    cancel: () => {
      generation += 1;
      controller?.abort();
    },
    refresh: async (spaceId) => {
      if (get().loading || get().refreshing || Date.now() - lastStartedAt < 30_000) return;
      await get().load(spaceId, { background: true });
    },
    load: async (spaceId, options) => {
      const keepContent = Boolean(options?.background && get().snapshot && lastSpaceId === (spaceId ?? null));
      lastStartedAt = Date.now();
      lastSpaceId = spaceId ?? null;
      const current = ++generation;
      controller?.abort();
      controller = new AbortController();
      const { signal } = controller;
      set({
        loading: !keepContent,
        refreshing: keepContent,
        error: null,
        ...(keepContent ? {} : { snapshot: null }),
      });
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
          refreshing: false,
        });
      } catch (error) {
        if (current === generation)
          set({ error, loading: false, refreshing: false, snapshot: null });
      }
    },
  }));
}
