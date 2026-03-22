/**
 * [INPUT]: 依赖 zustand 保存本地乐观未读覆盖，依赖 dashboard 类型定义与 api.markRoomRead 对接后端 room 级阅读水位
 * [OUTPUT]: 对外提供 useDashboardUnreadStore，管理 optimisticSeen/Unread 覆盖与实时未读提示
 * [POS]: frontend dashboard 的阅读语义协调层；数据库是最终真相源，这里只负责本地瞬时覆盖
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

import { create } from "zustand";
import type { DashboardRoom, RealtimeMetaEvent } from "@/lib/types";
import { api } from "@/lib/api";

interface DashboardUnreadState {
  optimisticSeenRoomIds: string[];
  optimisticUnreadRoomIds: string[];
  lastMarkedSeenAtByRoom: Record<string, string>;

  isRoomUnread: (roomId: string, persistedUnread?: boolean) => boolean;
  applyRealtimeEvent: (event: RealtimeMetaEvent) => void;
  reconcileUnreadRooms: (rooms: DashboardRoom[]) => void;
  markRoomSeen: (roomId: string, seenAt: string | null) => Promise<void>;
  resetUnreadState: () => void;
  logout: () => void;
}

const initialUnreadState = {
  optimisticSeenRoomIds: [],
  optimisticUnreadRoomIds: [],
  lastMarkedSeenAtByRoom: {},
};

export const useDashboardUnreadStore = create<DashboardUnreadState>()((set, get) => ({
  ...initialUnreadState,

  isRoomUnread: (roomId, persistedUnread = false) => {
    const state = get();
    if (state.optimisticSeenRoomIds.includes(roomId)) return false;
    return persistedUnread || state.optimisticUnreadRoomIds.includes(roomId);
  },

  applyRealtimeEvent: (event) =>
    set((state) => {
      if (!event.room_id) return state;
      return {
        optimisticSeenRoomIds: state.optimisticSeenRoomIds.filter((id) => id !== event.room_id),
        optimisticUnreadRoomIds: state.optimisticUnreadRoomIds.includes(event.room_id)
          ? state.optimisticUnreadRoomIds
          : [...state.optimisticUnreadRoomIds, event.room_id],
      };
    }),

  reconcileUnreadRooms: (rooms) =>
    set((state) => {
      const validRoomIds = new Set(rooms.map((room) => room.room_id));
      const nextSeen = new Set(state.optimisticSeenRoomIds);
      const nextUnread = new Set(state.optimisticUnreadRoomIds);
      const nextLastMarked = { ...state.lastMarkedSeenAtByRoom };

      for (const roomId of Array.from(nextSeen)) {
        if (!validRoomIds.has(roomId)) {
          nextSeen.delete(roomId);
          delete nextLastMarked[roomId];
        }
      }

      for (const roomId of Array.from(nextUnread)) {
        if (!validRoomIds.has(roomId)) {
          nextUnread.delete(roomId);
        }
      }

      for (const room of rooms) {
        if (!room.has_unread) {
          nextSeen.delete(room.room_id);
          nextUnread.delete(room.room_id);
          delete nextLastMarked[room.room_id];
        }
      }

      return {
        optimisticSeenRoomIds: Array.from(nextSeen),
        optimisticUnreadRoomIds: Array.from(nextUnread),
        lastMarkedSeenAtByRoom: nextLastMarked,
      };
    }),

  markRoomSeen: async (roomId, seenAt) => {
    set((state) => ({
      optimisticSeenRoomIds: state.optimisticSeenRoomIds.includes(roomId)
        ? state.optimisticSeenRoomIds
        : [...state.optimisticSeenRoomIds, roomId],
      optimisticUnreadRoomIds: state.optimisticUnreadRoomIds.filter((id) => id !== roomId),
    }));

    if (!seenAt || get().lastMarkedSeenAtByRoom[roomId] === seenAt) {
      return;
    }

    set((state) => ({
      lastMarkedSeenAtByRoom: { ...state.lastMarkedSeenAtByRoom, [roomId]: seenAt },
    }));

    try {
      await api.markRoomRead(roomId);
    } catch (error) {
      console.error("[UnreadStore] Failed to persist room read watermark:", error);
      set((state) => {
        const nextLastMarked = { ...state.lastMarkedSeenAtByRoom };
        delete nextLastMarked[roomId];
        return { lastMarkedSeenAtByRoom: nextLastMarked };
      });
    }
  },

  resetUnreadState: () => set({ ...initialUnreadState }),
  logout: () => set({ ...initialUnreadState }),
}));
