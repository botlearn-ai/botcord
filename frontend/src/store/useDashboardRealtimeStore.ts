/**
 * [INPUT]: 依赖 zustand 保存 realtime 连接状态，依赖 chat/contact/ui/session store 与 API 完成 meta 事件驱动的数据补全
 * [OUTPUT]: 对外提供 useDashboardRealtimeStore，管理连接状态与“事件 -> 最小同步”策略
 * [POS]: frontend dashboard 的 realtime 协调层，只负责连接结果与同步决策，不直接持有消息或未读数据
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

import { create } from "zustand";
import type { RealtimeMetaEvent } from "@/lib/types";
import { api } from "@/lib/api";
import { hasReadyActiveAgent } from "@/store/dashboard-shared";
import { useDashboardChatStore } from "@/store/useDashboardChatStore";
import { useDashboardContactStore } from "@/store/useDashboardContactStore";
import { useDashboardSessionStore } from "@/store/useDashboardSessionStore";
import { useDashboardUIStore } from "@/store/useDashboardUIStore";

let realtimeSyncInFlight = false;
let queuedRealtimeEvent: RealtimeMetaEvent | null = null;

function isContactRealtimeEvent(type: RealtimeMetaEvent["type"]): boolean {
  return type === "contact_request" || type === "contact_request_response" || type === "contact_removed";
}

function isMessageRealtimeEvent(type: RealtimeMetaEvent["type"]): boolean {
  return type === "message" || type === "ack" || type === "result" || type === "error";
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
    const { token, activeAgentId } = useDashboardSessionStore.getState();
    if (!hasReadyActiveAgent(token, activeAgentId)) return;

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

        const openedRoomId = useDashboardUIStore.getState().openedRoomId;
        const chatStore = useDashboardChatStore.getState();
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
          await chatStore.pollNewMessages(openedRoomId);
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

  resetRealtimeState: () => set({ ...initialRealtimeState }),
  logout: () => set({ ...initialRealtimeState }),
}));
