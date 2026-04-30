/**
 * [INPUT]: 依赖 zustand 保存 agent 状态对象的本地缓存，从 /api/presence/agents snapshot 与 realtime agent_status_changed 事件种子化
 * [OUTPUT]: 对外提供 usePresenceStore + usePresence (online?) + usePresenceStatus (full entry) hook
 * [POS]: frontend dashboard 出席状态汇总层，存 agentId -> AgentPresenceEntry，按 version 去重乱序
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

import { create } from "zustand";
import { useMemo } from "react";

export type AgentEffectiveStatus =
  | "offline"
  | "online"
  | "busy"
  | "away"
  | "working";

export interface AgentPresenceEntry {
  agentId: string;
  version: number;
  effectiveStatus: AgentEffectiveStatus;
  connected: boolean;
  manualStatus?: string | null;
  statusMessage?: string | null;
  activity: Record<string, unknown>;
  attributes: Record<string, unknown>;
  updatedAt: number;
}

export interface AgentPresenceSnapshotPayload {
  agent_id: string;
  version?: number;
  effective_status?: AgentEffectiveStatus;
  connected?: boolean;
  manual_status?: string | null;
  status_message?: string | null;
  activity?: Record<string, unknown>;
  attributes?: Record<string, unknown>;
  updated_at?: string;
}

interface PresenceState {
  entries: Record<string, AgentPresenceEntry>;
  upsertStatus: (snapshot: AgentPresenceSnapshotPayload) => void;
  upsertMany: (snapshots: AgentPresenceSnapshotPayload[]) => void;
  // Legacy boolean seeders — kept until REST APIs stop returning online/ws_online.
  setOnline: (agentId: string, online: boolean, updatedAt?: number) => void;
  seed: (seeds: Array<{ agentId: string; online: boolean }>) => void;
  reset: () => void;
}

function snapshotToEntry(s: AgentPresenceSnapshotPayload): AgentPresenceEntry {
  const updatedAt = s.updated_at ? new Date(s.updated_at).getTime() : Date.now();
  return {
    agentId: s.agent_id,
    version: s.version ?? 0,
    effectiveStatus: (s.effective_status ?? "offline") as AgentEffectiveStatus,
    connected: Boolean(s.connected),
    manualStatus: s.manual_status ?? null,
    statusMessage: s.status_message ?? null,
    activity: s.activity ?? {},
    attributes: s.attributes ?? {},
    updatedAt: Number.isFinite(updatedAt) ? updatedAt : Date.now(),
  };
}

function mergeEntry(
  prev: AgentPresenceEntry | undefined,
  next: AgentPresenceEntry,
): AgentPresenceEntry | null {
  if (prev) {
    // Out-of-order events: only accept if version is strictly higher, or if
    // version is 0 (legacy seed) and we have nothing fresher locally.
    if (next.version > 0 && prev.version >= next.version) return null;
    if (next.version === 0 && prev.version > 0) return null;
    if (
      prev.effectiveStatus === next.effectiveStatus
      && prev.connected === next.connected
      && prev.version === next.version
      && prev.manualStatus === next.manualStatus
    ) {
      return null;
    }
  }
  return next;
}

export const usePresenceStore = create<PresenceState>()((set) => ({
  entries: {},

  upsertStatus: (snapshot) =>
    set((state) => {
      const next = snapshotToEntry(snapshot);
      const merged = mergeEntry(state.entries[next.agentId], next);
      if (!merged) return state;
      return { entries: { ...state.entries, [next.agentId]: merged } };
    }),

  upsertMany: (snapshots) =>
    set((state) => {
      const entries = { ...state.entries };
      let changed = false;
      for (const raw of snapshots) {
        const next = snapshotToEntry(raw);
        const merged = mergeEntry(entries[next.agentId], next);
        if (merged) {
          entries[next.agentId] = merged;
          changed = true;
        }
      }
      return changed ? { entries } : state;
    }),

  setOnline: (agentId, online, updatedAt = Date.now()) =>
    set((state) => {
      const prev = state.entries[agentId];
      // Don't clobber a richer realtime-sourced entry with a stale boolean seed.
      if (prev && prev.version > 0) return state;
      if (prev && prev.updatedAt > updatedAt) return state;
      const entry: AgentPresenceEntry = {
        agentId,
        version: 0,
        effectiveStatus: online ? "online" : "offline",
        connected: online,
        manualStatus: null,
        statusMessage: null,
        activity: {},
        attributes: {},
        updatedAt,
      };
      return { entries: { ...state.entries, [agentId]: entry } };
    }),

  seed: (seeds) =>
    set((state) => {
      const now = Date.now();
      const next = { ...state.entries };
      let changed = false;
      for (const { agentId, online } of seeds) {
        if (next[agentId]) continue; // don't overwrite richer entries
        next[agentId] = {
          agentId,
          version: 0,
          effectiveStatus: online ? "online" : "offline",
          connected: online,
          manualStatus: null,
          statusMessage: null,
          activity: {},
          attributes: {},
          updatedAt: now,
        };
        changed = true;
      }
      return changed ? { entries: next } : state;
    }),

  reset: () => set({ entries: {} }),
}));

export function usePresence(agentId: string | null | undefined): boolean {
  return usePresenceStore((state) => {
    if (!agentId) return false;
    const entry = state.entries[agentId];
    return Boolean(entry && entry.effectiveStatus !== "offline");
  });
}

export function usePresenceStatus(
  agentId: string | null | undefined,
): AgentPresenceEntry | undefined {
  return usePresenceStore((state) =>
    agentId ? state.entries[agentId] : undefined,
  );
}

export function usePresenceMap(agentIds: string[]): Record<string, boolean> {
  const entries = usePresenceStore((state) => state.entries);
  return useMemo(() => {
    const out: Record<string, boolean> = {};
    for (const id of agentIds) {
      const entry = entries[id];
      out[id] = Boolean(entry && entry.effectiveStatus !== "offline");
    }
    return out;
  }, [entries, agentIds]);
}
