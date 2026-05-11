/**
 * [INPUT]: 依赖 zustand 保存 realtime 连接状态，依赖 chat/contact/ui/session store 与 API 完成 meta 事件驱动的数据补全
 * [OUTPUT]: 对外提供 useDashboardRealtimeStore，管理连接状态与“事件 -> 最小同步”策略
 * [POS]: frontend dashboard 的 realtime 协调层，只负责连接结果与同步决策，不直接持有消息或未读数据
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

import { create } from "zustand";
import type { RealtimeMetaEvent } from "@/lib/types";
import { api } from "@/lib/api";
import { useDashboardChatStore } from "@/store/useDashboardChatStore";
import { useDashboardContactStore } from "@/store/useDashboardContactStore";
import { useDashboardSessionStore } from "@/store/useDashboardSessionStore";
import { useDashboardUIStore } from "@/store/useDashboardUIStore";
import { useOwnerChatStore } from "@/store/useOwnerChatStore";

let realtimeSyncInFlight = false;
let queuedRealtimeEvent: RealtimeMetaEvent | null = null;
// Grace period: suppress stale typing events arriving shortly after an agent
// message.  Scoped to a specific room to avoid cross-session leakage.
let _lastOwnerChatAgentMsg: { roomId: string; at: number } | null = null;

function isContactRealtimeEvent(type: RealtimeMetaEvent["type"]): boolean {
  return type === "contact_request" || type === "contact_request_response" || type === "contact_removed";
}

function isMessageRealtimeEvent(type: RealtimeMetaEvent["type"]): boolean {
  return type === "message" || type === "ack" || type === "result" || type === "error" || type === "system";
}

function isTypingRealtimeEvent(type: RealtimeMetaEvent["type"]): boolean {
  return type === "typing";
}

function isRoomMemberRealtimeEvent(type: RealtimeMetaEvent["type"]): boolean {
  return type === "room_member_added" || type === "room_member_removed";
}

function isMessageLikeRealtimeEvent(event: RealtimeMetaEvent | null): event is RealtimeMetaEvent {
  return Boolean(event && isMessageRealtimeEvent(event.type) && event.room_id);
}

interface DashboardRealtimeState {
  realtimeStatus: "idle" | "connecting" | "connected" | "error";
  realtimeError: string | null;

  setRealtimeStatus: (status: DashboardRealtimeState["realtimeStatus"], error?: string | null) => void;
  syncRealtimeEvent: (event?: RealtimeMetaEvent) => Promise<void>;
  resetRealtimeState: () => void;
  logout: () => void;
}

const initialRealtimeState = {
  realtimeStatus: "idle" as const,
  realtimeError: null,
};

export const useDashboardRealtimeStore = create<DashboardRealtimeState>()((set) => ({
  ...initialRealtimeState,

  setRealtimeStatus: (realtimeStatus, realtimeError = null) =>
    set((state) => (
      state.realtimeStatus === realtimeStatus && state.realtimeError === realtimeError
        ? state
        : { realtimeStatus, realtimeError }
    )),

  syncRealtimeEvent: async (event) => {
    const { token, activeIdentity } = useDashboardSessionStore.getState();
    // Human-first: accept both Agent and Human viewer; only bail when we
    // have no token or no resolved identity to anchor on.
    if (!token || !activeIdentity) return;

    if (realtimeSyncInFlight) {
      queuedRealtimeEvent = event || queuedRealtimeEvent;
      return;
    }

    realtimeSyncInFlight = true;
    try {
      let nextEvent = event ?? null;
      do {
        const currentEvent = nextEvent;
        queuedRealtimeEvent = null;
        nextEvent = null;

        const uiState = useDashboardUIStore.getState();
        const openedRoomId = uiState.openedRoomId;
        const userChatRoomId = uiState.userChatRoomId;

        // Owner-chat WS handles its own realtime delivery — skip Supabase
        // realtime events for the owner-chat room when the WS is connected.
        const ownerChatWsConnected = useOwnerChatStore.getState().wsConnected;
        const isOwnerChatEvent = userChatRoomId && currentEvent?.room_id === userChatRoomId;

        // Handle typing events — just toggle the UI flag, no data fetching
        if (currentEvent && isTypingRealtimeEvent(currentEvent.type)) {
          if (isOwnerChatEvent && !ownerChatWsConnected) {
            // Suppress stale typing events arriving shortly after an agent message
            const grace = _lastOwnerChatAgentMsg;
            if (grace && grace.roomId === currentEvent.room_id && Date.now() - grace.at < 5_000) {
              nextEvent = queuedRealtimeEvent;
              continue;
            }
            useOwnerChatStore.getState().setAgentTyping(true);
          }
          nextEvent = queuedRealtimeEvent;
          continue;
        }

        // Clear typing indicator when a message arrives for the user-chat room.
        // Only record grace timestamp for actual "message" events (not ack/result/error).
        if (
          currentEvent
          && isMessageRealtimeEvent(currentEvent.type)
          && isOwnerChatEvent
          && !ownerChatWsConnected
        ) {
          if (currentEvent.type === "message" && currentEvent.room_id) {
            _lastOwnerChatAgentMsg = { roomId: currentEvent.room_id, at: Date.now() };
          }
          useOwnerChatStore.getState().setAgentTyping(false);
        }

        const chatStore = useDashboardChatStore.getState();
        if (currentEvent?.room_id && isRoomMemberRealtimeEvent(currentEvent.type)) {
          chatStore.bumpRoomMembersVersion(currentEvent.room_id);
        }

        const shouldRefreshOverview = (() => {
          if (!currentEvent) return true;
          if (isContactRealtimeEvent(currentEvent.type)) return true;
          if (!isMessageRealtimeEvent(currentEvent.type)) return true;
          if (!currentEvent.room_id) return true;
          return chatStore.getRoomSummary(currentEvent.room_id) === null;
        })();

        if (shouldRefreshOverview) {
          const overview = await api.getOverview();
          chatStore.replaceOverview(overview);
        }

        if (!currentEvent || isContactRealtimeEvent(currentEvent.type)) {
          await useDashboardContactStore.getState().loadContactRequests();
        }

        if (
          openedRoomId
          && (!currentEvent || currentEvent.room_id === openedRoomId)
        ) {
          await chatStore.pollNewMessages(openedRoomId, {
            expectedHubMsgId: isMessageLikeRealtimeEvent(currentEvent) ? currentEvent.hub_msg_id : null,
            retries: isMessageLikeRealtimeEvent(currentEvent) ? 2 : 0,
          });
        }

        // User-chat pane uses its own store. When WS is disconnected,
        // fetch new messages via API and merge into the owner-chat store.
        if (
          userChatRoomId
          && userChatRoomId !== openedRoomId
          && (!currentEvent || currentEvent.room_id === userChatRoomId)
          && !ownerChatWsConnected
        ) {
          try {
            const ocStore = useOwnerChatStore.getState();
            const existing = ocStore.messages;
            const newest = [...existing].reverse().find((m) => m.hubMsgId);
            const result = newest?.hubMsgId
              ? await api.getRoomMessages(userChatRoomId, { after: newest.hubMsgId, limit: 50 })
              : await api.getRoomMessages(userChatRoomId, { limit: 50 });
            if (result.messages.length > 0) {
              ocStore.mergeApiMessages(result.messages, "append");
            }
          } catch { /* non-critical */ }
        }

        nextEvent = queuedRealtimeEvent;
      } while (nextEvent);
    } catch (error: any) {
      console.error("[RealtimeStore] Failed to sync realtime event:", error);
      set({ realtimeError: error?.message || "Failed to sync realtime event", realtimeStatus: "error" });
    } finally {
      realtimeSyncInFlight = false;
    }
  },

  resetRealtimeState: () => { _lastOwnerChatAgentMsg = null; set({ ...initialRealtimeState }); },
  logout: () => { _lastOwnerChatAgentMsg = null; set({ ...initialRealtimeState }); },
}));
