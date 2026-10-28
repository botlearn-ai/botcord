/**
 * [INPUT]: 依赖 zustand 保存本地乐观未读覆盖，依赖 dashboard 类型定义与 api.markRoomRead 对接后端 room 级阅读水位
 * [OUTPUT]: 对外提供 useDashboardUnreadStore，管理即时已读覆盖、异步持久化、失败恢复与实时消息竞态
 * [POS]: frontend dashboard 的阅读语义协调层；数据库是最终真相源，这里只负责本地瞬时覆盖
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

import { useConversationDirectoryStore } from "./useConversationDirectoryStore";
import { create } from "zustand";
import type { DashboardRoom, RealtimeMetaEvent } from "@/lib/types";
import { api } from "@/lib/api";

interface DashboardUnreadState {
  pendingReadRoomIds: string[];
  markRoomRead: (roomId: string) => Promise<boolean>;
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

let generation = 0;
const roomVersions = new Map<string, number>();
const bumpRoom = (id: string) => { const v = (roomVersions.get(id) ?? 0) + 1; roomVersions.set(id, v); return v; };

const initialUnreadState = {
  pendingReadRoomIds: [] as string[],
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
      if (!event.room_id || !["message", "system"].includes(event.type)) return state;
      bumpRoom(event.room_id);
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
        if (state.pendingReadRoomIds.includes(room.room_id)) continue;
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

  // Explicit list action: update locally before starting I/O. Responses must
  // never clear a newer realtime message or restore another account's state.
  markRoomRead: async (roomId) => {
    if (get().pendingReadRoomIds.includes(roomId)) return true;
    const before = get();
    const requestGeneration = generation;
    const accountId = useConversationDirectoryStore.getState().accountId;
    const version = bumpRoom(roomId);
    const sameAccount = () => generation === requestGeneration
      && useConversationDirectoryStore.getState().accountId === accountId;
    const unchanged = () => sameAccount() && roomVersions.get(roomId) === version;
    set({
      pendingReadRoomIds: [...before.pendingReadRoomIds, roomId],
      optimisticSeenRoomIds: [...new Set([...before.optimisticSeenRoomIds, roomId])],
      optimisticUnreadRoomIds: before.optimisticUnreadRoomIds.filter((id) => id !== roomId),
    });
    try {
      await api.markRoomRead(roomId);
      if (!sameAccount()) return true;
      if (unchanged()) useConversationDirectoryStore.getState().patch(roomId, { has_unread: false, unread_count: 0 });
      void useConversationDirectoryStore.getState().sync();
      return true;
    } catch {
      if (!sameAccount()) return true;
      if (unchanged()) set((state) => ({
        optimisticSeenRoomIds: state.optimisticSeenRoomIds.filter((id) => id !== roomId)
          .concat(before.optimisticSeenRoomIds.includes(roomId) ? [roomId] : []),
        optimisticUnreadRoomIds: state.optimisticUnreadRoomIds.filter((id) => id !== roomId)
          .concat(before.optimisticUnreadRoomIds.includes(roomId) ? [roomId] : []),
      }));
      return false;
    } finally {
      if (sameAccount()) set((state) => ({ pendingReadRoomIds: state.pendingReadRoomIds.filter((id) => id !== roomId) }));
    }
  },

  markRoomSeen: async (roomId, seenAt) => {
    const version = bumpRoom(roomId);
    const requestGeneration = generation;
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

    const accountId = useConversationDirectoryStore.getState().accountId;
    try {
      await api.markRoomRead(roomId);
      if (generation !== requestGeneration || useConversationDirectoryStore.getState().accountId !== accountId
        || roomVersions.get(roomId) !== version) return;
      useConversationDirectoryStore.getState().patch(roomId, { has_unread: false, unread_count: 0 });
      void useConversationDirectoryStore.getState().sync();
    } catch (error) {
      if (generation !== requestGeneration || roomVersions.get(roomId) !== version) return;
      console.error("[UnreadStore] Failed to persist room read watermark:", error);
      set((state) => {
        const nextLastMarked = { ...state.lastMarkedSeenAtByRoom };
        delete nextLastMarked[roomId];
        return { lastMarkedSeenAtByRoom: nextLastMarked };
      });
    }
  },

  resetUnreadState: () => { generation += 1; roomVersions.clear(); set({ ...initialUnreadState }); },
  logout: () => get().resetUnreadState(),
}));
