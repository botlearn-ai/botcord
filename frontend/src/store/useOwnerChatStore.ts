/**
 * Unified owner-chat message store.
 *
 * Replaces three disjoint data sources:
 *   1. `useDashboardChatStore.messages[roomId]`  (confirmed messages)
 *   2. `UserChatPane`'s local `pending[]` state   (optimistic messages)
 *   3. `useOwnerChatStreamStore`                   (stream blocks)
 *
 * Design: single ordered `messages[]` array with a status lifecycle
 * (optimistic → confirmed → delivered, or streaming → delivered).
 * All writes are merge/append — never replace.
 */

import { create } from "zustand";
import { api } from "@/lib/api";
import type {
  Attachment,
  OwnerChatMessage,
  StreamBlockEntry,
  DashboardMessage,
} from "@/lib/types";
import { dashboardMsgToOwnerChat } from "@/lib/types";

const MAX_BLOCKS_PER_TRACE = 200;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract streamed assistant text from stream blocks. */
function extractAssistantText(blocks: StreamBlockEntry[]): string {
  return blocks
    .filter((b) => b.block.kind === "assistant")
    .map((b) => (b.block.payload?.text as string) || "")
    .join("");
}

/** In-flight guard + request token to prevent stale loadInitial responses. */
let loadInFlight = false;
let loadRequestId = 0;
/** In-flight guard to prevent concurrent loadMore calls. */
let moreInFlight = false;

// ---------------------------------------------------------------------------
// State definition
// ---------------------------------------------------------------------------

export interface OwnerChatState {
  roomId: string | null;
  agentName: string;
  messages: OwnerChatMessage[];
  hasMore: boolean;
  loading: boolean;
  error: string | null;
  wsConnected: boolean;
  agentTyping: boolean;
  activeTraceId: string | null;

  // Initialization
  setRoom: (roomId: string, agentName: string) => void;
  loadInitial: (roomId: string) => Promise<void>;
  loadMore: () => Promise<void>;

  // Message lifecycle
  addOptimistic: (msg: OwnerChatMessage) => void;
  confirmOptimistic: (clientId: string, hubMsgId: string, createdAt: string, attachments?: Attachment[]) => void;
  failOptimistic: (clientId: string, error: string) => void;
  resetForRetry: (clientId: string) => void;

  // Server-delivered messages
  upsertMessage: (msg: OwnerChatMessage) => void;
  mergeApiMessages: (msgs: DashboardMessage[], direction: "append") => void;

  // Streaming
  appendStreamBlock: (entry: StreamBlockEntry) => void;
  finalizeStream: (traceId: string, finalData: {
    hubMsgId: string;
    text: string;
    senderName: string;
    createdAt: string;
    attachments?: Attachment[];
  }) => void;

  // Connection state
  setWsConnected: (connected: boolean) => void;
  setAgentTyping: (typing: boolean) => void;
  onDisconnect: () => void;
  reset: () => void;
}

const initialState = {
  roomId: null as string | null,
  agentName: "",
  messages: [] as OwnerChatMessage[],
  hasMore: false,
  loading: false,
  error: null as string | null,
  wsConnected: false,
  agentTyping: false,
  activeTraceId: null as string | null,
};

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useOwnerChatStore = create<OwnerChatState>()((set, get) => ({
  ...initialState,

  // ------ Initialization ------

  setRoom: (roomId, agentName) => set({ roomId, agentName }),

  loadInitial: async (roomId) => {
    // Allow re-entry if room changed (e.g. onAuthOk correction) — the stale
    // response guard (thisRequestId) will discard the earlier request's result.
    if (loadInFlight && get().roomId === roomId) return;
    loadInFlight = true;
    const thisRequestId = ++loadRequestId;
    set({ loading: true, error: null });

    try {
      const result = await api.getRoomMessages(roomId, { limit: 50 });

      // Discard stale response if room changed (agent switch / onAuthOk correction)
      if (thisRequestId !== loadRequestId || get().roomId !== roomId) return;

      const agentName = get().agentName;
      const apiMsgs = result.messages.reverse().map((m) => dashboardMsgToOwnerChat(m, agentName));

      set((state) => {
        // Build lookup for API messages by hubMsgId
        const apiByHubId = new Map<string, OwnerChatMessage>();
        for (const m of apiMsgs) {
          if (m.hubMsgId) apiByHubId.set(m.hubMsgId, m);
        }

        // Build lookup for existing messages by hubMsgId
        const existingByHubId = new Map<string, OwnerChatMessage>();
        for (const m of state.messages) {
          if (m.hubMsgId) existingByHubId.set(m.hubMsgId, m);
        }

        const merged: OwnerChatMessage[] = [];
        const seenHubIds = new Set<string>();

        // Start with API messages (authoritative ordering)
        for (const apiMsg of apiMsgs) {
          if (apiMsg.hubMsgId) seenHubIds.add(apiMsg.hubMsgId);
          // Prefer local version if it has richer state (e.g., streamBlocks)
          const local = apiMsg.hubMsgId ? existingByHubId.get(apiMsg.hubMsgId) : undefined;
          merged.push(local && local.streamBlocks.length > 0 ? local : apiMsg);
        }

        // Append any existing messages not in the API response
        for (const existing of state.messages) {
          if (existing.hubMsgId && seenHubIds.has(existing.hubMsgId)) continue;
          // Keep optimistic/failed messages (they have no hubMsgId or a different one)
          if (existing.status === "optimistic" || existing.status === "failed") {
            merged.push(existing);
            continue;
          }
          // Keep WS-delivered messages that arrived after the API snapshot
          if (existing.hubMsgId && !seenHubIds.has(existing.hubMsgId)) {
            merged.push(existing);
          }
          // Keep streaming messages
          if (existing.status === "streaming") {
            merged.push(existing);
          }
        }

        return {
          messages: merged,
          hasMore: result.has_more,
          loading: false,
          roomId,
        };
      });
    } catch (err: any) {
      set({ error: err?.message || "Failed to load messages", loading: false });
    } finally {
      loadInFlight = false;
    }
  },

  loadMore: async () => {
    const { messages, roomId, hasMore } = get();
    if (!roomId || !hasMore || moreInFlight) return;

    // Find oldest message with a hubMsgId (skip optimistic)
    const oldest = messages.find((m) => m.hubMsgId);
    if (!oldest?.hubMsgId) return;

    moreInFlight = true;
    try {
      const result = await api.getRoomMessages(roomId, {
        before: oldest.hubMsgId,
        limit: 50,
      });
      const agentName = get().agentName;
      const older = result.messages.reverse().map((m) => dashboardMsgToOwnerChat(m, agentName));

      set((state) => ({
        messages: [...older, ...state.messages],
        hasMore: result.has_more,
      }));
    } catch (err) {
      console.error("[OwnerChatStore] Failed to load more:", err);
    } finally {
      moreInFlight = false;
    }
  },

  // ------ Message lifecycle ------

  addOptimistic: (msg) =>
    set((state) => ({ messages: [...state.messages, msg] })),

  confirmOptimistic: (clientId, hubMsgId, createdAt, attachments) =>
    set((state) => ({
      messages: state.messages.map((m) =>
        m.clientId === clientId
          ? { ...m, hubMsgId, status: "confirmed" as const, createdAt, attachments: attachments ?? m.attachments, sendText: undefined, retryFiles: undefined }
          : m
      ),
    })),

  failOptimistic: (clientId, error) =>
    set((state) => ({
      messages: state.messages.map((m) =>
        m.clientId === clientId && m.status === "optimistic"
          ? { ...m, status: "failed" as const, error }
          : m
      ),
    })),

  resetForRetry: (clientId) =>
    set((state) => ({
      messages: state.messages.map((m) =>
        m.clientId === clientId && m.status === "failed"
          ? { ...m, status: "optimistic" as const, error: undefined }
          : m
      ),
    })),

  // ------ Server-delivered messages ------

  upsertMessage: (msg) =>
    set((state) => {
      // Dedup by hubMsgId
      if (msg.hubMsgId && state.messages.some((m) => m.hubMsgId === msg.hubMsgId)) {
        return state;
      }

      // Match optimistic user message by clientId (sent as client_msg_id via WS)
      if (msg.sender === "user" && msg.hubMsgId) {
        const confirmUpdate = (m: OwnerChatMessage): OwnerChatMessage => ({
          ...m,
          hubMsgId: msg.hubMsgId,
          status: "confirmed" as const,
          createdAt: msg.createdAt,
          text: msg.text || m.text,
          attachments: msg.attachments ?? m.attachments,
          sendText: undefined,
          retryFiles: undefined,
        });

        const optimistic = state.messages.find((m) =>
          m.status === "optimistic"
          && m.sender === "user"
          && m.clientId === msg.clientId
        );
        if (optimistic) {
          return {
            messages: state.messages.map((m) =>
              m.clientId === optimistic.clientId ? confirmUpdate(m) : m
            ),
          };
        }

        // Fallback: match by text + timestamp proximity
        const textMatch = state.messages.find((m) =>
          m.status === "optimistic"
          && m.sender === "user"
          && (m.sendText || m.text) === msg.text
        );
        if (textMatch) {
          return {
            messages: state.messages.map((m) =>
              m.clientId === textMatch.clientId ? confirmUpdate(m) : m
            ),
          };
        }
      }

      // Append new message
      return { messages: [...state.messages, msg] };
    }),

  mergeApiMessages: (msgs, _direction) => {
    const agentName = get().agentName;
    // API returns newest-first; reverse to chronological order before merge
    const converted = [...msgs].reverse().map((m) => dashboardMsgToOwnerChat(m, agentName));

    set((state) => {
      const existingIds = new Set(
        state.messages.filter((m) => m.hubMsgId).map((m) => m.hubMsgId!)
      );
      const deduped = converted.filter((m) => m.hubMsgId && !existingIds.has(m.hubMsgId));
      if (deduped.length === 0) return state;
      return { messages: [...state.messages, ...deduped] };
    });
  },

  // ------ Streaming ------

  appendStreamBlock: (entry) =>
    set((state) => {
      const traceId = entry.trace_id;

      // Find existing streaming message for this trace
      const idx = state.messages.findIndex(
        (m) => m.traceId === traceId && m.status === "streaming"
      );

      if (idx === -1) {
        // Create a new streaming placeholder
        const streamingMsg: OwnerChatMessage = {
          clientId: `stream_${traceId}`,
          hubMsgId: null,
          sender: "agent",
          text: extractAssistantText([entry]),
          streamBlocks: [entry],
          status: "streaming",
          createdAt: entry.created_at,
          senderName: state.agentName,
          type: "message",
          traceId,
        };
        return {
          messages: [...state.messages, streamingMsg],
          activeTraceId: traceId,
          agentTyping: false,
        };
      }

      // Append block to existing streaming message
      const existing = state.messages[idx];
      if (existing.streamBlocks.length >= MAX_BLOCKS_PER_TRACE) return state;
      if (existing.streamBlocks.some((b) => b.seq === entry.seq)) return state;

      const updatedBlocks = [...existing.streamBlocks, entry].sort((a, b) => a.seq - b.seq);
      const updatedMsg: OwnerChatMessage = {
        ...existing,
        streamBlocks: updatedBlocks,
        text: extractAssistantText(updatedBlocks),
      };

      const newMessages = [...state.messages];
      newMessages[idx] = updatedMsg;

      return {
        messages: newMessages,
        activeTraceId: traceId,
        agentTyping: false,
      };
    }),

  finalizeStream: (traceId, finalData) =>
    set((state) => {
      const idx = state.messages.findIndex(
        (m) => m.traceId === traceId && m.status === "streaming"
      );

      if (idx === -1) {
        // No streaming placeholder — insert as a new delivered message
        const msg: OwnerChatMessage = {
          clientId: finalData.hubMsgId,
          hubMsgId: finalData.hubMsgId,
          sender: "agent",
          text: finalData.text,
          attachments: finalData.attachments,
          streamBlocks: [],
          status: "delivered",
          createdAt: finalData.createdAt,
          senderName: finalData.senderName,
          type: "message",
          traceId,
        };

        // Dedup
        if (state.messages.some((m) => m.hubMsgId === finalData.hubMsgId)) {
          return { activeTraceId: null };
        }

        return {
          messages: [...state.messages, msg],
          activeTraceId: null,
        };
      }

      // Upgrade streaming placeholder to delivered
      const existing = state.messages[idx];
      const finalizedMsg: OwnerChatMessage = {
        ...existing,
        hubMsgId: finalData.hubMsgId,
        text: finalData.text,
        senderName: finalData.senderName,
        createdAt: finalData.createdAt,
        attachments: finalData.attachments,
        status: "delivered",
        // Keep only execution blocks (strip assistant text — now in the final message text)
        streamBlocks: existing.streamBlocks.filter((b) => b.block.kind !== "assistant"),
      };

      const newMessages = [...state.messages];
      newMessages[idx] = finalizedMsg;

      return {
        messages: newMessages,
        activeTraceId: null,
      };
    }),

  // ------ Connection state ------

  setWsConnected: (connected) => set({ wsConnected: connected }),

  setAgentTyping: (typing) => set({ agentTyping: typing }),

  onDisconnect: () =>
    set((state) => ({
      wsConnected: false,
      agentTyping: false,
      activeTraceId: null,
      messages: state.messages
        // Fail all optimistic messages
        .map((m) =>
          m.status === "optimistic"
            ? { ...m, status: "failed" as const, error: "Connection lost" }
            : m
        )
        // Remove streaming messages (cannot be recovered)
        .filter((m) => m.status !== "streaming"),
    })),

  reset: () => {
    loadInFlight = false;
    moreInFlight = false;
    loadRequestId++;
    set({ ...initialState });
  },
}));
