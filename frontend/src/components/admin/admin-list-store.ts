import { createStore } from "zustand/vanilla";

/** Page-local lists: retain the same query during refresh; isolate changed filters. */
export function createAdminListStore<T>(fetchRows: (key: string) => Promise<T[]>) {
  let generation = 0;
  let currentKey: string | null = null;
  return createStore<{
    key: string | null;
    rows: T[];
    loading: boolean;
    error: string | null;
    setError: (error: string | null) => void;
    load: (key: string) => Promise<void>;
    refresh: () => Promise<void>;
    cancel: () => void;
  }>((set, get) => ({
    key: null,
    rows: [],
    loading: true,
    error: null,
    setError: (error) => set({ error }),
    cancel: () => { generation++; },
    refresh: async () => {
      if (currentKey !== null) await get().load(currentKey);
    },
    load: async (key) => {
      const version = ++generation;
      const keepRows = currentKey === key && !get().loading && !get().error;
      currentKey = key;
      set({ key, loading: !keepRows, error: null, ...(keepRows ? {} : { rows: [] }) });
      try {
        const rows = await fetchRows(key);
        if (generation === version) set({ rows, loading: false });
      } catch (cause) {
        if (generation === version)
          set({ rows: [], loading: false, error: cause instanceof Error ? cause.message : "加载失败" });
      }
    },
  }));
}
