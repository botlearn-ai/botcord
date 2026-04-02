/**
 * Ephemeral store for owner-chat execution stream blocks.
 * Active blocks are shown during execution; finalized blocks are kept
 * collapsed alongside the final agent message.
 */
import { create } from "zustand";
import type { StreamBlockEntry } from "@/lib/types";

const MAX_BLOCKS_PER_TRACE = 200;

interface OwnerChatStreamState {
  /** Active stream blocks keyed by trace_id, ordered by seq. */
  activeBlocks: Record<string, StreamBlockEntry[]>;
  /** Finalized blocks keyed by hub_msg_id (the final agent message). */
  finalizedBlocks: Record<string, StreamBlockEntry[]>;
  /** Whether the owner-chat WS is connected. */
  wsConnected: boolean;

  addStreamBlock: (entry: StreamBlockEntry) => void;
  /** Move active blocks from traceId into finalized under hubMsgId. */
  finalizeTrace: (traceId: string, hubMsgId: string) => void;
  clearTrace: (traceId: string) => void;
  setWsConnected: (connected: boolean) => void;
  reset: () => void;
}

export const useOwnerChatStreamStore = create<OwnerChatStreamState>((set) => ({
  activeBlocks: {},
  finalizedBlocks: {},
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

  finalizeTrace: (traceId, hubMsgId) =>
    set((state) => {
      const blocks = state.activeBlocks[traceId];
      if (!blocks || blocks.length === 0) return state;
      const { [traceId]: _, ...restActive } = state.activeBlocks;
      // Only keep execution blocks (exclude assistant text which is in the message)
      const executionBlocks = blocks.filter((b) => b.block.kind !== "assistant");
      if (executionBlocks.length === 0) return { activeBlocks: restActive };
      return {
        activeBlocks: restActive,
        finalizedBlocks: { ...state.finalizedBlocks, [hubMsgId]: executionBlocks },
      };
    }),

  clearTrace: (traceId) =>
    set((state) => {
      const { [traceId]: _, ...rest } = state.activeBlocks;
      return { activeBlocks: rest };
    }),

  setWsConnected: (connected) => set({ wsConnected: connected }),

  reset: () => set({ activeBlocks: {}, finalizedBlocks: {}, wsConnected: false }),
}));
