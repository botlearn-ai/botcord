/** Activity read model: feed and statistics resolve independently; cached rows survive tab revisits. */
import { create } from "zustand";
import { api } from "@/lib/api";
import type { ActivityFeedItem, ActivityStats } from "@/lib/types";
import { useDashboardSessionStore } from "@/store/useDashboardSessionStore";

export type ActivityPeriod = "today" | "7d" | "30d";

const initialState = {
  feed: [] as ActivityFeedItem[],
  hasMore: false,
  loaded: false,
  loading: false,
  loadingMore: false,
  error: null as string | null,
  statsByPeriod: {} as Partial<Record<ActivityPeriod, ActivityStats>>,
};

function sessionKey() {
  const { token, activeIdentity, activeAgentId, viewMode } = useDashboardSessionStore.getState();
  return JSON.stringify([token, activeIdentity?.type, activeIdentity?.id, activeAgentId, viewMode]);
}

let generation = 0;
let feedRequest: Promise<void> | null = null;
const statsRequests = new Map<ActivityPeriod, Promise<void>>();

interface ActivityState {
  feed: ActivityFeedItem[];
  hasMore: boolean;
  loaded: boolean;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  statsByPeriod: Partial<Record<ActivityPeriod, ActivityStats>>;
  reset: () => void;
  loadFeed: (loadMore?: boolean) => Promise<void>;
  loadStats: (period: ActivityPeriod) => Promise<void>;
}

export const useDashboardActivityStore = create<ActivityState>()((set, get) => ({
  ...initialState,
  reset: () => {
    generation += 1;
    feedRequest = null;
    statsRequests.clear();
    set(initialState);
  },
  loadFeed: (loadMore = false) => {
    if (feedRequest) return feedRequest;
    if (!useDashboardSessionStore.getState().token || (loadMore && !get().hasMore)) return Promise.resolve();
    const requestGeneration = generation;
    const key = sessionKey();
    const isCurrent = () => requestGeneration === generation && key === sessionKey();
    const offset = loadMore ? get().feed.length : undefined;
    set({ loading: !loadMore, loadingMore: loadMore, error: null });
    const request = (async () => {
      try {
        const result = await api.getActivityFeed({ limit: 30, offset });
        if (!isCurrent()) return;
        set((state) => ({
          feed: loadMore ? [...state.feed, ...result.items] : result.items,
          hasMore: result.has_more,
          loaded: true,
        }));
      } catch (error) {
        if (isCurrent()) set({ error: error instanceof Error ? error.message : "Failed to load activity" });
      } finally {
        if (isCurrent()) {
          set({ loading: false, loadingMore: false });
          feedRequest = null;
        }
      }
    })();
    feedRequest = request;
    return request;
  },
  loadStats: (period) => {
    const pending = statsRequests.get(period);
    if (pending) return pending;
    if (!useDashboardSessionStore.getState().token) return Promise.resolve();
    const requestGeneration = generation;
    const key = sessionKey();
    const isCurrent = () => requestGeneration === generation && key === sessionKey();
    const request = (async () => {
      try {
        const stats = await api.getActivityStats(period);
        if (isCurrent()) set((state) => ({ statsByPeriod: { ...state.statsByPeriod, [period]: stats } }));
      } catch {
        // Statistics are supplementary: preserve feed and last successful statistics.
      } finally {
        if (isCurrent()) statsRequests.delete(period);
      }
    })();
    statsRequests.set(period, request);
    return request;
  },
}));

let lastSessionKey = sessionKey();
useDashboardSessionStore.subscribe(() => {
  const nextKey = sessionKey();
  if (nextKey !== lastSessionKey) {
    lastSessionKey = nextKey;
    useDashboardActivityStore.getState().reset();
  }
});
