import { createStore } from "zustand/vanilla";
import { api, ApiError } from "@/lib/api";
import type { PublicRoomMessagePreview } from "@/lib/types";

const PREVIEW_LIMIT = 3;
const MAX_CACHED_ROOMS = 32;
const MAX_PREVIEW_AGE_MS = 60_000;

function createPreviewStore(roomId: string) {
  let pending: Promise<void> | null = null;
  return createStore<{
    messages: PublicRoomMessagePreview[] | null;
    loading: boolean;
    error: unknown;
    loadedAt: number;
    load: () => Promise<void>;
  }>((set, get) => ({
    messages: null,
    loading: true,
    error: null,
    loadedAt: 0,
    load: () => {
      if (pending) return pending;
      set({ loading: get().messages === null, error: null });
      const task = (async () => {
        try {
          // This endpoint returns public, truncated summaries only. Never use
          // the protected message-history API to fill this cache.
          const response = await api.getPublicRoomMessagePreviews(roomId);
          set({ messages: response.messages.slice(0, PREVIEW_LIMIT), loadedAt: Date.now(), error: null });
        } catch (error) {
          const state = get();
          const unavailable = error instanceof ApiError && [400, 401, 403, 404, 410].includes(error.status);
          const fresh = state.messages !== null && Date.now() - state.loadedAt < MAX_PREVIEW_AGE_MS;
          // Revoked/removed previews fail closed; a short network outage may
          // retain a still-fresh public summary and offer an explicit retry.
          set(unavailable || !fresh
            ? { messages: null, loadedAt: 0, error }
            : { error });
        } finally {
          set({ loading: false });
        }
      })();
      pending = task;
      void task.finally(() => { if (pending === task) pending = null; });
      return task;
    },
  }));
}

type PreviewStore = ReturnType<typeof createPreviewStore>;
const previews = new Map<string, PreviewStore>();

/**
 * Public summaries are identical for all viewers (the endpoint has no user
 * dependency). Scope by room + subscription product, never reuse full history.
 * Keep only a short-lived, bounded in-memory cache; a new visit revalidates it.
 */
export function getPaidRoomPreviewStore(roomId: string, productId: string): PreviewStore {
  const key = JSON.stringify([roomId, productId]);
  let store = previews.get(key);
  if (store && store.getState().loadedAt > 0 && Date.now() - store.getState().loadedAt >= MAX_PREVIEW_AGE_MS) {
    previews.delete(key);
    store = undefined;
  }
  if (!store) store = createPreviewStore(roomId);
  // Insertion order acts as LRU. Evicted in-flight stores cannot reinsert themselves.
  previews.delete(key);
  previews.set(key, store);
  while (previews.size > MAX_CACHED_ROOMS) {
    previews.delete(previews.keys().next().value!);
  }
  return store;
}
