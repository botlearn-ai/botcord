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

/** Extract streamed assistant text from stream blocks.
 *  Supports two shapes:
 *   - legacy plugin: `{ kind: "assistant", payload: { text } }`
 *   - daemon gateway: `{ kind: "assistant_text", raw: <runtime event> }` where
 *     raw is either Codex's `item.completed` (`raw.item.text`) or Claude-code's
 *     `assistant` event (`raw.message.content[*].text`). */
function extractAssistantText(blocks: StreamBlockEntry[]): string {
  const parts: string[] = [];
  for (const b of blocks) {
    const kind = b.block.kind;
    if (kind === "assistant") {
      parts.push((b.block.payload?.text as string) || "");
      continue;
    }
    if (kind === "assistant_text") {
      const raw = b.block.raw as any;
      // Codex: raw.item.text
      if (typeof raw?.item?.text === "string") {
        parts.push(raw.item.text);
        continue;
      }
      // Claude-code: raw.message.content[*].text where type === "text"
      const contents = raw?.message?.content;
      if (Array.isArray(contents)) {
        for (const c of contents) {
          if (c?.type === "text" && typeof c.text === "string") parts.push(c.text);
        }
      }
    }
  }
  return parts.join("");
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
  reconcileAfterReconnect: () => Promise<void>;
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

      // Reconcile: if a server message matches a failed optimistic message, confirm it
      const failedUserMsgs = state.messages.filter(
        (m) => m.status === "failed" && m.sender === "user" && m.error === "Connection lost"
      );
      let reconciled = state.messages;
      const reconciledServerIds = new Set<string>();

      if (failedUserMsgs.length > 0) {
        const serverUserMsgs = converted.filter((m) => m.sender === "user");
        reconciled = state.messages.map((m) => {
          if (m.status !== "failed" || m.sender !== "user" || m.error !== "Connection lost") return m;
          const sendText = m.sendText || m.text;
          const match = serverUserMsgs.find(
            (sm) => sm.text === sendText && sm.hubMsgId && !reconciledServerIds.has(sm.hubMsgId)
          );
          if (match && match.hubMsgId) {
            reconciledServerIds.add(match.hubMsgId);
            return {
              ...m,
              hubMsgId: match.hubMsgId,
              status: "confirmed" as const,
              createdAt: match.createdAt,
              error: undefined,
              sendText: undefined,
              retryFiles: undefined,
            };
          }
          return m;
        });
      }

      const deduped = converted.filter(
        (m) => m.hubMsgId && !existingIds.has(m.hubMsgId) && !reconciledServerIds.has(m.hubMsgId)
      );
      if (deduped.length === 0 && reconciled === state.messages) return state;
      return { messages: deduped.length > 0 ? [...reconciled, ...deduped] : reconciled };
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
      // Preserve the streamed assistant text if it is richer than the final
      // `message` text (e.g. Codex streams long intermediate reasoning/answer
      // segments but only sends a short summary via botcord_send).
      const streamedText = extractAssistantText(existing.streamBlocks);
      const finalText = finalData.text || "";
      let mergedText: string;
      if (streamedText.length > finalText.length) {
        mergedText =
          finalText && !streamedText.includes(finalText)
            ? `${streamedText}\n\n${finalText}`
            : streamedText;
      } else {
        mergedText = finalText;
      }
      const finalizedMsg: OwnerChatMessage = {
        ...existing,
        hubMsgId: finalData.hubMsgId,
        text: mergedText,
        senderName: finalData.senderName,
        createdAt: finalData.createdAt,
        attachments: finalData.attachments,
        status: "delivered",
        // Keep only execution blocks (assistant text now lives in `text`)
        streamBlocks: existing.streamBlocks.filter((b) => b.block.kind !== "assistant" && b.block.kind !== "assistant_text"),
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
      messages: state.messages.map((m) => {
        if (m.status === "optimistic") {
          // Mark as failed but flag for reconnect reconciliation
          return { ...m, status: "failed" as const, error: "Connection lost" };
        }
        if (m.status === "streaming") {
          // Preserve partial streamed content instead of dropping
          const partialText = m.text || extractAssistantText(m.streamBlocks);
          if (!partialText && m.streamBlocks.length === 0) {
            // Empty streaming placeholder — safe to drop
            return null;
          }
          return {
            ...m,
            text: partialText,
            status: "delivered" as const,
            // Keep streamBlocks for display (execution blocks, etc.)
            streamBlocks: m.streamBlocks.filter((b) => b.block.kind !== "assistant" && b.block.kind !== "assistant_text"),
          };
        }
        return m;
      }).filter((m): m is OwnerChatMessage => m !== null),
    })),

  reconcileAfterReconnect: async () => {
    const { roomId, messages, agentName } = get();
    if (!roomId) return;

    // Find failed user messages that were caused by disconnect (candidates for reconciliation)
    const failedMsgs = messages.filter(
      (m) => m.status === "failed" && m.sender === "user" && m.error === "Connection lost"
    );
    if (failedMsgs.length === 0) return;

    try {
      // Fetch recent messages from server to check if any "failed" sends actually went through
      const newest = [...messages].reverse().find((m) => m.hubMsgId && m.status !== "failed");
      const result = newest?.hubMsgId
        ? await api.getRoomMessages(roomId, { after: newest.hubMsgId, limit: 50 })
        : await api.getRoomMessages(roomId, { limit: 50 });

      if (result.messages.length === 0) return;

      const serverMsgs = result.messages.map((m) => dashboardMsgToOwnerChat(m, agentName));
      const serverTexts = new Set(serverMsgs.map((m) => m.text));

      set((state) => {
        const existingHubIds = new Set(
          state.messages.filter((m) => m.hubMsgId).map((m) => m.hubMsgId!)
        );

        const updatedMessages = state.messages.map((m) => {
          // Only reconcile disconnect-failed user messages
          if (m.status !== "failed" || m.sender !== "user" || m.error !== "Connection lost") {
            return m;
          }

          // Check if server received this message (match by text content)
          const sendText = m.sendText || m.text;
          const serverMatch = serverMsgs.find(
            (sm) => sm.sender === "user" && sm.text === sendText
          );
          if (serverMatch) {
            return {
              ...m,
              hubMsgId: serverMatch.hubMsgId,
              status: "confirmed" as const,
              createdAt: serverMatch.createdAt,
              error: undefined,
              sendText: undefined,
              retryFiles: undefined,
            };
          }

          return m;
        });

        // Append any new server messages not already in our list
        const newServerMsgs = serverMsgs.filter(
          (sm) => sm.hubMsgId && !existingHubIds.has(sm.hubMsgId)
            // Skip messages we just reconciled above
            && !updatedMessages.some((m) => m.hubMsgId === sm.hubMsgId)
        );

        return {
          messages: newServerMsgs.length > 0
            ? [...updatedMessages, ...newServerMsgs]
            : updatedMessages,
        };
      });
    } catch (err) {
      console.error("[OwnerChatStore] Failed to reconcile after reconnect:", err);
    }
  },

  reset: () => {
    loadInFlight = false;
    moreInFlight = false;
    loadRequestId++;
    set({ ...initialState });
  },
}));
