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
  ReplyPreview,
  StreamBlockEntry,
  DashboardMessage,
  RunStreamBlocksResponse,
} from "@/lib/types";
import { dashboardMsgToOwnerChat } from "@/lib/types";
import { useDashboardChatStore } from "@/store/useDashboardChatStore";

const MAX_BLOCKS_PER_TRACE = 200;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract streamed assistant text from stream blocks.
 *  Supports three shapes:
 *   - legacy structured payload: `{ kind: "assistant", payload: { text } }`
 *   - daemon gateway pure text: `{ kind: "assistant_text", raw: <event> }`
 *   - daemon gateway mixed: `{ kind: "tool_use", raw: <Claude assistant event> }`
 *     where Claude-code labelled the block as tool_use because the content
 *     array contained both `text` and `tool_use` items. We still want the
 *     prose so the chat bubble doesn't lose it. */
function extractAssistantText(blocks: StreamBlockEntry[]): string {
  const parts: string[] = [];
  for (const b of blocks) {
    const kind = b.block.kind;
    if (kind === "assistant") {
      parts.push((b.block.payload?.text as string) || "");
      continue;
    }
    if (kind === "assistant_text" || kind === "tool_use") {
      const raw = b.block.raw as any;
      // Codex assistant_text: raw.item.text
      if (kind === "assistant_text" && typeof raw?.item?.text === "string") {
        parts.push(raw.item.text);
        continue;
      }
      // DeepSeek TUI: raw { event: "item.delta", payload: { kind: "agent_message", delta } }
      if (
        kind === "assistant_text" &&
        raw?.event === "item.delta" &&
        (raw?.payload?.kind === "agent_message" || raw?.payload?.payload?.kind === "agent_message")
      ) {
        parts.push(
          typeof raw?.payload?.delta === "string"
            ? raw.payload.delta
            : typeof raw?.payload?.payload?.delta === "string"
              ? raw.payload.payload.delta
              : "",
        );
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

function latestPreviewableMessage(messages: OwnerChatMessage[]): OwnerChatMessage | null {
  return messages.reduce<OwnerChatMessage | null>((latest, msg) => {
    if (msg.type === "error" || msg.status === "failed") return latest;
    if (!msg.text.trim() && (msg.attachments?.length ?? 0) === 0) return latest;
    if (!latest) return msg;
    return Date.parse(msg.createdAt) >= Date.parse(latest.createdAt) ? msg : latest;
  }, null);
}

function syncOwnerChatRoomSummary(roomId: string | null, messages: OwnerChatMessage[]): void {
  if (!roomId) return;
  const latest = latestPreviewableMessage(messages);
  if (!latest) return;
  useDashboardChatStore.getState().patchOwnerChatRoomSummary(roomId, {
    last_message_at: latest.createdAt,
    last_message_preview: latest.text || ((latest.attachments?.length ?? 0) > 0 ? "[Attachment]" : ""),
    last_sender_name: latest.senderName || (latest.sender === "user" ? "You" : null),
  });
}

function hasVisibleOwnerChatContent(msg: OwnerChatMessage): boolean {
  if (msg.type !== "message") return true;
  if (msg.status === "streaming" || msg.status === "optimistic" || msg.status === "failed") return true;
  if (msg.text.trim()) return true;
  if ((msg.attachments?.length ?? 0) > 0) return true;
  return visibleExecutionBlocks(msg.streamBlocks).length > 0;
}

function visibleExecutionBlocks(blocks: StreamBlockEntry[]): StreamBlockEntry[] {
  return blocks.filter(
    (b) =>
      b.block.kind !== "assistant" &&
      b.block.kind !== "assistant_text" &&
      b.block.kind !== "system",
  );
}

function mergeStreamedAndFinalText(streamedText: string, finalText: string): string {
  if (streamedText.length > finalText.length) {
    return finalText && !streamedText.includes(finalText)
      ? `${streamedText}\n\n${finalText}`
      : streamedText;
  }
  return finalText;
}

function mergeFinalAgentMessage(
  existing: OwnerChatMessage,
  finalMsg: OwnerChatMessage,
): OwnerChatMessage | null {
  const streamedText = extractAssistantText(existing.streamBlocks) || existing.text;
  const mergedText = mergeStreamedAndFinalText(streamedText, finalMsg.text || "");
  const visibleStreamBlocks = visibleExecutionBlocks(existing.streamBlocks);
  const attachments = finalMsg.attachments ?? existing.attachments;

  if (!mergedText.trim() && (attachments?.length ?? 0) === 0 && visibleStreamBlocks.length === 0) {
    return null;
  }

  return {
    ...existing,
    ...finalMsg,
    text: mergedText,
    attachments,
    status: "delivered",
    streamBlocks: visibleStreamBlocks,
    traceId: finalMsg.traceId ?? existing.traceId,
    replyPreview: finalMsg.replyPreview ?? existing.replyPreview ?? undefined,
  };
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
  /** Restore cached in-flight stream blocks (refresh/reconnect recovery).
   *  Replays each event through the live append/dedupe path. */
  restoreStreamBlocks: (run: RunStreamBlocksResponse) => void;
  /** Fetch + restore active runs for the current room (no final reply yet).
   *  `agentId` is the owner-chat agent (needed for the X-Active-Agent header). */
  restoreActiveRuns: (agentId: string) => Promise<void>;
  finalizeStream: (traceId: string, finalData: {
    hubMsgId: string;
    text: string;
    senderName: string;
    createdAt: string;
    attachments?: Attachment[];
    replyPreview?: ReplyPreview | null;
  }) => void;

  // Connection state
  setWsConnected: (connected: boolean) => void;
  setAgentTyping: (typing: boolean) => void;
  onDisconnect: () => void;
  reconcileAfterReconnect: () => Promise<void>;
  reset: () => void;

  // Quote-reply
  replyingTo: OwnerChatMessage | null;
  setReplyingTo: (msg: OwnerChatMessage | null) => void;
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
  replyingTo: null as OwnerChatMessage | null,
};

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useOwnerChatStore = create<OwnerChatState>()((set, get) => ({
  ...initialState,

  // ------ Initialization ------

  setRoom: (roomId, agentName) => set({ roomId, agentName }),

  setReplyingTo: (msg) => set({ replyingTo: msg }),

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
      const apiMsgs = result.messages
        .reverse()
        .map((m) => dashboardMsgToOwnerChat(m, agentName))
        .filter(hasVisibleOwnerChatContent);

      set((state) => {
        // Build lookup for existing messages by hubMsgId
        const existingByHubId = new Map<string, OwnerChatMessage>();
        const existingByTraceId = new Map<string, OwnerChatMessage>();
        for (const m of state.messages) {
          if (m.hubMsgId) existingByHubId.set(m.hubMsgId, m);
          if (m.sender === "agent" && m.traceId) existingByTraceId.set(m.traceId, m);
        }

        const merged: OwnerChatMessage[] = [];
        const seenHubIds = new Set<string>();
        const seenTraceIds = new Set<string>();

        // Start with API messages (authoritative ordering)
        for (const apiMsg of apiMsgs) {
          if (apiMsg.hubMsgId) seenHubIds.add(apiMsg.hubMsgId);
          if (apiMsg.traceId) seenTraceIds.add(apiMsg.traceId);

          // Prefer local version if it has richer state (e.g., streamBlocks),
          // including the common reconnect case where the API final message
          // has a hub id but the local stream placeholder only has traceId.
          const local = apiMsg.hubMsgId ? existingByHubId.get(apiMsg.hubMsgId) : undefined;
          const traceLocal = apiMsg.traceId ? existingByTraceId.get(apiMsg.traceId) : undefined;
          if (traceLocal && traceLocal.streamBlocks.length > 0) {
            merged.push(mergeFinalAgentMessage(traceLocal, apiMsg) ?? apiMsg);
          } else if (local && local.streamBlocks.length > 0) {
            merged.push(mergeFinalAgentMessage(local, apiMsg) ?? apiMsg);
          } else {
            merged.push(apiMsg);
          }
        }

        // Append any existing messages not in the API response
        for (const existing of state.messages) {
          if (existing.hubMsgId && seenHubIds.has(existing.hubMsgId)) continue;
          if (existing.traceId && seenTraceIds.has(existing.traceId)) continue;
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
      syncOwnerChatRoomSummary(roomId, get().messages);
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
      const older = result.messages
        .reverse()
        .map((m) => dashboardMsgToOwnerChat(m, agentName))
        .filter(hasVisibleOwnerChatContent);

      set((state) => ({
        messages: [...older, ...state.messages],
        hasMore: result.has_more,
      }));
      syncOwnerChatRoomSummary(roomId, get().messages);
    } catch (err) {
      console.error("[OwnerChatStore] Failed to load more:", err);
    } finally {
      moreInFlight = false;
    }
  },

  // ------ Message lifecycle ------

  addOptimistic: (msg) => {
    set((state) => ({ messages: [...state.messages, msg] }));
    syncOwnerChatRoomSummary(get().roomId, get().messages);
  },

  confirmOptimistic: (clientId, hubMsgId, createdAt, attachments) => {
    set((state) => ({
      messages: state.messages.map((m) =>
        m.clientId === clientId
          ? { ...m, hubMsgId, status: "confirmed" as const, createdAt, attachments: attachments ?? m.attachments, sendText: undefined, retryFiles: undefined, retryReplyTo: undefined }
          : m
      ),
    }));
    syncOwnerChatRoomSummary(get().roomId, get().messages);
  },

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

  upsertMessage: (msg) => {
    set((state) => {
      if (!hasVisibleOwnerChatContent(msg)) return state;

      // Dedup by hubMsgId
      if (msg.hubMsgId && state.messages.some((m) => m.hubMsgId === msg.hubMsgId)) {
        return state;
      }

      if (msg.sender === "agent" && msg.traceId) {
        const traceIdx = state.messages.findIndex(
          (m) => m.sender === "agent" && m.traceId === msg.traceId,
        );
        if (traceIdx !== -1) {
          const merged = mergeFinalAgentMessage(state.messages[traceIdx], msg);
          const nextMessages = [...state.messages];
          if (merged) {
            nextMessages[traceIdx] = merged;
          } else {
            nextMessages.splice(traceIdx, 1);
          }
          return { messages: nextMessages };
        }
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
          retryReplyTo: undefined,
          replyPreview: msg.replyPreview ?? m.replyPreview,
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
    });
    syncOwnerChatRoomSummary(get().roomId, get().messages);
  },

  mergeApiMessages: (msgs, _direction) => {
    const agentName = get().agentName;
    // API returns newest-first; reverse to chronological order before merge
    const converted = [...msgs]
      .reverse()
      .map((m) => dashboardMsgToOwnerChat(m, agentName))
      .filter(hasVisibleOwnerChatContent);

    set((state) => {
      const existingIds = new Set(
        state.messages.filter((m) => m.hubMsgId).map((m) => m.hubMsgId!)
      );
      const existingTraceIds = new Set(
        state.messages.filter((m) => m.sender === "agent" && m.traceId).map((m) => m.traceId!)
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
              retryReplyTo: undefined,
              replyPreview: match.replyPreview ?? m.replyPreview,
            };
          }
          return m;
        });
      }

      let nextMessages = reconciled;
      let changed = reconciled !== state.messages;

      for (const msg of converted) {
        if (!msg.hubMsgId || existingIds.has(msg.hubMsgId) || reconciledServerIds.has(msg.hubMsgId)) {
          continue;
        }

        if (msg.sender === "agent" && msg.traceId && existingTraceIds.has(msg.traceId)) {
          const traceIdx = nextMessages.findIndex((m) => m.sender === "agent" && m.traceId === msg.traceId);
          if (traceIdx !== -1) {
            const merged = mergeFinalAgentMessage(nextMessages[traceIdx], msg);
            const copy = [...nextMessages];
            if (merged) copy[traceIdx] = merged;
            else copy.splice(traceIdx, 1);
            nextMessages = copy;
            changed = true;
            existingIds.add(msg.hubMsgId);
            continue;
          }
        }

        nextMessages = [...nextMessages, msg];
        existingIds.add(msg.hubMsgId);
        if (msg.traceId) existingTraceIds.add(msg.traceId);
        changed = true;
      }

      if (!changed) return state;
      return { messages: nextMessages };
    });
    syncOwnerChatRoomSummary(get().roomId, get().messages);
  },

  // ------ Streaming ------

  appendStreamBlock: (entry) => {
    set((state) => {
      const traceId = entry.trace_id;

      // Find existing streaming message for this trace
      const idx = state.messages.findIndex(
        (m) => m.traceId === traceId && (m.status === "streaming" || m.sender === "agent")
      );

      if (idx === -1) {
        // Create a streaming placeholder. A terminal runtime block is not the
        // final chat response; the placeholder remains streaming until the
        // traced agent message arrives via finalizeStream().
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
      const updatedText = extractAssistantText(updatedBlocks);
      const finalized = existing.status === "delivered";
      const updatedMsg: OwnerChatMessage = {
        ...existing,
        streamBlocks: finalized ? visibleExecutionBlocks(updatedBlocks) : updatedBlocks,
        text: finalized
          ? mergeStreamedAndFinalText(updatedText, existing.text)
          : updatedText || existing.text,
        status: existing.status,
      };

      const newMessages = [...state.messages];
      newMessages[idx] = updatedMsg;

      return {
        messages: newMessages,
        activeTraceId: traceId,
        agentTyping: false,
      };
    });
    syncOwnerChatRoomSummary(get().roomId, get().messages);
  },

  restoreStreamBlocks: (run) => {
    // Only running runs have replayable in-flight state. A completed/failed or
    // expired run (status !== "running" or empty events) means "nothing to
    // restore" — degrade gracefully and wait for live WS / final message.
    if (run.status !== "running") return;
    if (!run.events || run.events.length === 0) return;

    const append = get().appendStreamBlock;
    for (const ev of run.events) {
      // Live WS blocks always carry a numeric seq; skip malformed cache rows.
      if (typeof ev.seq !== "number") continue;
      // Replay through the live path so placeholder creation, ordering, and
      // (trace_id, seq) dedupe all match the WS stream_block handler exactly.
      append({
        trace_id: run.trace_id,
        seq: ev.seq,
        block: ev.block,
        created_at: ev.created_at ?? new Date().toISOString(),
      });
    }
  },

  restoreActiveRuns: async (agentId) => {
    if (!agentId) return;
    const { messages } = get();

    // Trace ids already covered by a streaming placeholder or a finalized
    // agent reply — never re-restore those.
    const coveredTraceIds = new Set<string>();
    for (const m of messages) {
      if (m.sender === "agent" && m.traceId) coveredTraceIds.add(m.traceId);
      if (m.status === "streaming" && m.traceId) coveredTraceIds.add(m.traceId);
    }

    // Candidate in-flight traces: confirmed/delivered user messages whose
    // hub_msg_id (== trace_id) has no agent reply or streaming placeholder yet.
    const candidates = messages
      .filter(
        (m) =>
          m.sender === "user" &&
          m.hubMsgId &&
          (m.status === "confirmed" || m.status === "delivered") &&
          !coveredTraceIds.has(m.hubMsgId),
      )
      .map((m) => m.hubMsgId!);

    if (candidates.length === 0) return;

    await Promise.all(
      candidates.map(async (traceId) => {
        try {
          const run = await api.getRunStreamBlocks(traceId, agentId);
          // Discard stale result if the trace got covered while we were fetching.
          const covered = get().messages.some(
            (m) =>
              (m.sender === "agent" && m.traceId === traceId) ||
              (m.status === "streaming" && m.traceId === traceId),
          );
          if (covered) return;
          get().restoreStreamBlocks(run);
        } catch (err) {
          // Network error / missing run — degrade gracefully, never throw.
          console.error("[OwnerChatStore] Failed to restore run:", traceId, err);
        }
      }),
    );
  },

  finalizeStream: (traceId, finalData) => {
    set((state) => {
      const idx = state.messages.findIndex(
        (m) => m.traceId === traceId && (m.status === "streaming" || m.sender === "agent")
      );

      if (idx === -1) {
        if (!finalData.text.trim() && (finalData.attachments?.length ?? 0) === 0) {
          return { activeTraceId: null };
        }

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
          replyPreview: finalData.replyPreview ?? undefined,
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
      const finalMsg: OwnerChatMessage = {
        ...existing,
        hubMsgId: finalData.hubMsgId,
        text: finalData.text,
        senderName: finalData.senderName,
        createdAt: finalData.createdAt,
        attachments: finalData.attachments,
        status: "delivered",
        streamBlocks: [],
        traceId,
        replyPreview: finalData.replyPreview ?? undefined,
      };
      const finalizedMsg = mergeFinalAgentMessage(existing, finalMsg);
      if (!finalizedMsg) {
        const newMessages = state.messages.filter((_, i) => i !== idx);
        return {
          messages: newMessages,
          activeTraceId: null,
        };
      }

      const newMessages = [...state.messages];
      newMessages[idx] = finalizedMsg;

      return {
        messages: newMessages,
        activeTraceId: null,
      };
    });
    syncOwnerChatRoomSummary(get().roomId, get().messages);
  },

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
            streamBlocks: visibleExecutionBlocks(m.streamBlocks),
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

      const serverMsgs = result.messages
        .map((m) => dashboardMsgToOwnerChat(m, agentName))
        .filter(hasVisibleOwnerChatContent);

      set((state) => {
        const existingHubIds = new Set(
          state.messages.filter((m) => m.hubMsgId).map((m) => m.hubMsgId!)
        );
        const existingTraceIds = new Set(
          state.messages.filter((m) => m.sender === "agent" && m.traceId).map((m) => m.traceId!)
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

        let nextMessages = updatedMessages;

        // Append any new server messages not already in our list, merging agent
        // finals into same-trace stream placeholders when reconnect races.
        for (const sm of serverMsgs) {
          if (
            !sm.hubMsgId ||
            existingHubIds.has(sm.hubMsgId) ||
            updatedMessages.some((m) => m.hubMsgId === sm.hubMsgId)
          ) {
            continue;
          }

          if (sm.sender === "agent" && sm.traceId && existingTraceIds.has(sm.traceId)) {
            const traceIdx = nextMessages.findIndex((m) => m.sender === "agent" && m.traceId === sm.traceId);
            if (traceIdx !== -1) {
              const merged = mergeFinalAgentMessage(nextMessages[traceIdx], sm);
              const copy = [...nextMessages];
              if (merged) copy[traceIdx] = merged;
              else copy.splice(traceIdx, 1);
              nextMessages = copy;
              existingHubIds.add(sm.hubMsgId);
              continue;
            }
          }

          nextMessages = [...nextMessages, sm];
          existingHubIds.add(sm.hubMsgId);
          if (sm.traceId) existingTraceIds.add(sm.traceId);
        }

        return {
          messages: nextMessages,
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
