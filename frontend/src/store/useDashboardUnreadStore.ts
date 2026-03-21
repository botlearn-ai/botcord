/**
 * [INPUT]: 依赖 zustand/persist 保存房间阅读水位，依赖 dashboard 类型定义做 room 级未读维护
 * [OUTPUT]: 对外提供 useDashboardUnreadStore，管理 lastSeenAtByRoom、unreadRoomIds 与实时未读提示
 * [POS]: frontend dashboard 的阅读语义状态源，只负责“看没看到”，不负责拉数据或建连接
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { DashboardRoom, RealtimeMetaEvent } from "@/lib/types";
import { getIsoTimestampValue } from "@/store/dashboard-shared";

interface DashboardUnreadState {
  lastSeenAtByRoom: Record<string, string>;
  unreadRoomIds: string[];

  isRoomUnread: (roomId: string) => boolean;
  applyRealtimeEvent: (event: RealtimeMetaEvent) => void;
  reconcileUnreadRooms: (rooms: DashboardRoom[]) => void;
  markRoomSeen: (roomId: string, seenAt: string | null) => void;
  resetUnreadState: () => void;
  logout: () => void;
}

const initialUnreadState = {
  lastSeenAtByRoom: {},
  unreadRoomIds: [],
};

export const useDashboardUnreadStore = create<DashboardUnreadState>()(
  persist(
    (set, get) => ({
      ...initialUnreadState,

      isRoomUnread: (roomId) => get().unreadRoomIds.includes(roomId),

      applyRealtimeEvent: (event) =>
        set((state) => {
          if (!event.room_id) return state;
          const seenAt = state.lastSeenAtByRoom[event.room_id];
          if (getIsoTimestampValue(event.created_at) <= getIsoTimestampValue(seenAt)) {
            return state;
          }
          return {
            unreadRoomIds: state.unreadRoomIds.includes(event.room_id)
              ? state.unreadRoomIds
              : [...state.unreadRoomIds, event.room_id],
          };
        }),

      reconcileUnreadRooms: (rooms) =>
        set((state) => {
          const nextUnread = new Set(state.unreadRoomIds);
          const validRoomIds = new Set(rooms.map((room) => room.room_id));

          for (const roomId of Array.from(nextUnread)) {
            if (!validRoomIds.has(roomId)) {
              nextUnread.delete(roomId);
            }
          }

          return { unreadRoomIds: Array.from(nextUnread) };
        }),

      markRoomSeen: (roomId, seenAt) =>
        set((state) => {
          if (!seenAt && !state.unreadRoomIds.includes(roomId)) {
            return state;
          }
          return {
            lastSeenAtByRoom: seenAt
              ? { ...state.lastSeenAtByRoom, [roomId]: seenAt }
              : state.lastSeenAtByRoom,
            unreadRoomIds: state.unreadRoomIds.filter((id) => id !== roomId),
          };
        }),

      resetUnreadState: () => set({ ...initialUnreadState }),
      logout: () => set({ ...initialUnreadState }),
    }),
    {
      name: "dashboard-unread-storage",
      partialize: (state) => ({
        lastSeenAtByRoom: state.lastSeenAtByRoom,
        unreadRoomIds: state.unreadRoomIds,
      }),
    },
  ),
);
