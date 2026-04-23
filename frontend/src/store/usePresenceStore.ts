/**
 * [INPUT]: 依赖 zustand 保存 agent 在线状态的本地缓存，从列表接口或 realtime 事件种子化
 * [OUTPUT]: 对外提供 usePresenceStore 与 usePresence hook，给 UI 读取任意 agent 的 online/offline
 * [POS]: frontend dashboard 的出席状态汇总层，只存 agentId -> {online, updatedAt}，不直接发请求
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

import { create } from "zustand";
import { useMemo } from "react";

interface PresenceEntry {
  online: boolean;
  updatedAt: number;
}

interface PresenceState {
  entries: Record<string, PresenceEntry>;
  setOnline: (agentId: string, online: boolean, updatedAt?: number) => void;
  seed: (seeds: Array<{ agentId: string; online: boolean }>) => void;
  reset: () => void;
}

export const usePresenceStore = create<PresenceState>()((set) => ({
  entries: {},

  setOnline: (agentId, online, updatedAt = Date.now()) =>
    set((state) => {
      const prev = state.entries[agentId];
      // Ignore out-of-order events
      if (prev && prev.updatedAt > updatedAt) return state;
      if (prev && prev.online === online && prev.updatedAt >= updatedAt) return state;
      return {
        entries: {
          ...state.entries,
          [agentId]: { online, updatedAt },
        },
      };
    }),

  seed: (seeds) =>
    set((state) => {
      const now = Date.now();
      let changed = false;
      const next = { ...state.entries };
      for (const { agentId, online } of seeds) {
        const prev = next[agentId];
        // Snapshot only seeds if we have nothing yet, so we don't overwrite
        // fresher realtime-sourced state.
        if (!prev) {
          next[agentId] = { online, updatedAt: now };
          changed = true;
        }
      }
      return changed ? { entries: next } : state;
    }),

  reset: () => set({ entries: {} }),
}));

export function usePresence(agentId: string | null | undefined): boolean {
  return usePresenceStore((state) =>
    agentId ? Boolean(state.entries[agentId]?.online) : false,
  );
}

export function usePresenceMap(agentIds: string[]): Record<string, boolean> {
  const entries = usePresenceStore((state) => state.entries);
  return useMemo(() => {
    const out: Record<string, boolean> = {};
    for (const id of agentIds) out[id] = Boolean(entries[id]?.online);
    return out;
  }, [entries, agentIds]);
}
