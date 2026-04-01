/**
 * Ephemeral store for owner-chat execution stream blocks.
 * Blocks are grouped by trace_id and cleared when the final agent message arrives.
 */
import { create } from "zustand";
import type { StreamBlockEntry } from "@/lib/types";

const MAX_BLOCKS_PER_TRACE = 200;

interface OwnerChatStreamState {
  /** Active stream blocks keyed by trace_id, ordered by seq. */
  activeBlocks: Record<string, StreamBlockEntry[]>;
  /** Whether the owner-chat WS is connected. */
  wsConnected: boolean;

  addStreamBlock: (entry: StreamBlockEntry) => void;
  clearTrace: (traceId: string) => void;
  setWsConnected: (connected: boolean) => void;
  reset: () => void;
}

export const useOwnerChatStreamStore = create<OwnerChatStreamState>((set) => ({
  activeBlocks: {},
  wsConnected: false,

  addStreamBlock: (entry) =>
    set((state) => {
      const existing = state.activeBlocks[entry.trace_id] || [];
      if (existing.length >= MAX_BLOCKS_PER_TRACE) return state;
      // Dedup by seq
      if (existing.some((b) => b.seq === entry.seq)) return state;
      const updated = [...existing, entry].sort((a, b) => a.seq - b.seq);
      return {
        activeBlocks: { ...state.activeBlocks, [entry.trace_id]: updated },
      };
    }),

  clearTrace: (traceId) =>
    set((state) => {
      const { [traceId]: _, ...rest } = state.activeBlocks;
      return { activeBlocks: rest };
    }),

  setWsConnected: (connected) => set({ wsConnected: connected }),

  reset: () => set({ activeBlocks: {}, wsConnected: false }),
}));
