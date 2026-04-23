/**
 * [INPUT]: 依赖 zustand/persist 保存 dashboard 会话与目录数据，依赖 @/lib/api 发起房间/目录/Agent 查询，依赖 session/ui/unread/contact store 提供鉴权、界面上下文与未读协调
 * [OUTPUT]: 对外提供 useDashboardChatStore，管理 overview、消息缓存、公开房间/Agent、Agent 卡片数据与 chat 相关异步动作
 * [POS]: frontend dashboard 的 chat 数据状态源，负责真正的会话数据与目录数据，不负责阅读语义和连接生命周期
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";
import type {
  AgentProfile,
  DashboardMessage,
  DashboardOverview,
  DashboardRoom,
  DiscoverRoom,
  PublicRoom,
  RealtimeMetaEvent,
} from "@/lib/types";
import { api } from "@/lib/api";
import {
  buildVisibleMessageRooms,
  hasReadyActiveAgent,
  roomMessagesInFlight,
  roomPollInFlight,
  toRoomSummary,
} from "@/store/dashboard-shared";
import { useDashboardContactStore } from "@/store/useDashboardContactStore";
import { useDashboardSessionStore } from "@/store/useDashboardSessionStore";
import { useDashboardUIStore } from "@/store/useDashboardUIStore";
import { useDashboardUnreadStore } from "@/store/useDashboardUnreadStore";

function applyRealtimeRoomHint<T extends {
  room_id: string;
  last_message_at: string | null;
  last_message_preview: string | null;
  last_sender_name: string | null;
}>(room: T, event: RealtimeMetaEvent): T {
  if (room.room_id !== event.room_id) return room;

  const preview = typeof event.ext.preview === "string"
    ? event.ext.preview
    : room.last_message_preview;

  const senderName = typeof event.ext.display_sender_name === "string"
    ? event.ext.display_sender_name
    : typeof event.ext.sender_name === "string"
      ? event.ext.sender_name
      : room.last_sender_name;

  return {
    ...room,
    last_message_at: event.created_at > (room.last_message_at ?? "") ? event.created_at : room.last_message_at,
    last_message_preview: preview,
    last_sender_name: senderName,
  };
}

interface DashboardChatState {
  boundAgentId: string | null;
  overviewRefreshing: boolean;
  overviewErrored: boolean;
  overview: DashboardOverview | null;
  messages: Record<string, DashboardMessage[]>;
  messagesLoading: Record<string, boolean>;
  messagesHasMore: Record<string, boolean>;
  error: string | null;
  selectedAgentId: string | null;
  selectedAgentLoading: boolean;
  selectedAgentError: string | null;
  selectedAgentProfile: AgentProfile | null;
  selectedAgentConversations: DashboardRoom[] | null;
  searchResults: AgentProfile[] | null;
  discoverRooms: DiscoverRoom[];
  discoverLoading: boolean;
  joiningRoomId: string | null;
  leavingRoomId: string | null;
  publicRooms: PublicRoom[];
  publicRoomDetails: Record<string, PublicRoom>;
  publicRoomsLoading: boolean;
  publicRoomsLoaded: boolean;
  publicAgents: AgentProfile[];
  publicAgentsLoading: boolean;
  publicAgentsLoaded: boolean;
  recentVisitedRooms: PublicRoom[];

  setError: (error: string | null) => void;
  addRecentPublicRoom: (room: PublicRoom) => void;
  bindToActiveAgent: (agentId: string | null) => void;
  resetChatState: () => void;
  logout: () => void;
  closeAgentCardState: () => void;
  getRoomSummary: (roomId: string) => DashboardRoom | null;
  getVisibleMessageRooms: () => DashboardRoom[];
  hasMessage: (roomId: string, hubMsgId: string) => boolean;
  applyRealtimeEventHint: (event: RealtimeMetaEvent) => void;
  replaceOverview: (overview: DashboardOverview) => void;
  patchRoom: (roomId: string, patch: Partial<DashboardRoom>) => void;

  insertMessage: (roomId: string, message: DashboardMessage) => void;
  loadRoomMessages: (roomId: string) => Promise<void>;
  pollNewMessages: (roomId: string, opts?: { expectedHubMsgId?: string | null; retries?: number }) => Promise<void>;
  loadMoreMessages: (roomId: string) => Promise<void>;
  selectAgent: (agentId: string) => Promise<void>;
  searchAgents: (q: string) => Promise<void>;
  refreshOverview: (opts?: { reloadOpenedRoom?: boolean }) => Promise<void>;
  loadDiscoverRooms: () => Promise<void>;
  joinRoom: (roomId: string) => Promise<void>;
  leaveRoom: (roomId: string) => Promise<void>;
  loadPublicRooms: () => Promise<void>;
  loadPublicRoomDetail: (roomId: string) => Promise<PublicRoom | null>;
  loadPublicAgents: () => Promise<void>;
  switchActiveAgent: (agentId: string) => Promise<void>;
}

const initialChatState = {
  boundAgentId: null,
  overviewRefreshing: false,
  overviewErrored: false,
  overview: null,
  messages: {},
  messagesLoading: {},
  messagesHasMore: {},
  error: null,
  selectedAgentId: null,
  selectedAgentLoading: false,
  selectedAgentError: null,
  selectedAgentProfile: null,
  selectedAgentConversations: null,
  searchResults: null,
  discoverRooms: [],
  discoverLoading: false,
  joiningRoomId: null,
  leavingRoomId: null,
  publicRooms: [],
  publicRoomDetails: {},
  publicRoomsLoading: false,
  publicRoomsLoaded: false,
  publicAgents: [],
  publicAgentsLoading: false,
  publicAgentsLoaded: false,
  recentVisitedRooms: [],
};

function hasTransientChatState(state: DashboardChatState): boolean {
  return (
    state.overviewRefreshing
    || state.overviewErrored
    || state.overview !== null
    || Object.keys(state.messages).length > 0
    || Object.keys(state.messagesLoading).length > 0
    || Object.keys(state.messagesHasMore).length > 0
    || state.error !== null
    || state.selectedAgentId !== null
    || state.selectedAgentLoading
    || state.selectedAgentError !== null
    || state.selectedAgentProfile !== null
    || state.selectedAgentConversations !== null
    || state.searchResults !== null
    || state.discoverRooms.length > 0
    || state.discoverLoading
    || state.joiningRoomId !== null
    || state.leavingRoomId !== null
    || state.publicRoomsLoading
    || state.publicAgentsLoading
  );
}

let _errorTimerId: ReturnType<typeof setTimeout> | null = null;

export const useDashboardChatStore = create<DashboardChatState>()(
  persist(
    (set, get) => ({
      ...initialChatState,

      setError: (error) => {
        set({ error });
        if (_errorTimerId) {
          clearTimeout(_errorTimerId);
          _errorTimerId = null;
        }
        if (error) {
          _errorTimerId = setTimeout(() => {
            _errorTimerId = null;
            if (get().error === error) set({ error: null });
          }, 4000);
        }
      },

      addRecentPublicRoom: (room) =>
        set((state) => ({
          recentVisitedRooms: [
            room,
            ...state.recentVisitedRooms.filter((item) => item.room_id !== room.room_id),
          ].slice(0, 20),
        })),

      bindToActiveAgent: (agentId) =>
        set((state) => {
          if (state.boundAgentId === agentId) {
            return state;
          }
          return {
            ...initialChatState,
            boundAgentId: agentId,
            publicRooms: state.publicRooms,
            publicAgents: state.publicAgents,
            publicRoomDetails: state.publicRoomDetails,
          };
        }),

      resetChatState: () =>
        set((state) => {
          if (!hasTransientChatState(state)) {
            return state;
          }
          return {
            ...initialChatState,
            recentVisitedRooms: state.recentVisitedRooms,
            publicRooms: state.publicRooms,
            publicAgents: state.publicAgents,
            publicRoomDetails: state.publicRoomDetails,
          };
        }),

      logout: () =>
        set({
          ...initialChatState,
          publicRooms: get().publicRooms,
          publicAgents: get().publicAgents,
          publicRoomDetails: get().publicRoomDetails,
        }),

      closeAgentCardState: () =>
        set((state) => ({
          selectedAgentId: state.selectedAgentId,
          selectedAgentProfile: state.selectedAgentProfile,
          selectedAgentConversations: state.selectedAgentConversations,
          selectedAgentLoading: false,
          selectedAgentError: null,
        })),

      getRoomSummary: (roomId) => {
        const state = get();
        const joinedRoom = state.overview?.rooms.find((room) => room.room_id === roomId);
        if (joinedRoom) return joinedRoom;
        const publicRoom = state.publicRooms.find((room) => room.room_id === roomId) || state.publicRoomDetails[roomId];
        if (publicRoom) return toRoomSummary(publicRoom);
        const recentRoom = state.recentVisitedRooms.find((room) => room.room_id === roomId);
        return recentRoom ? toRoomSummary(recentRoom) : null;
      },

      getVisibleMessageRooms: () =>
        buildVisibleMessageRooms({
          overview: get().overview,
          recentVisitedRooms: get().recentVisitedRooms,
          token: useDashboardSessionStore.getState().token,
        }),

      hasMessage: (roomId, hubMsgId) => {
        if (!hubMsgId) return false;
        return (get().messages[roomId] || []).some((message) => message.hub_msg_id === hubMsgId);
      },

      insertMessage: (roomId, message) =>
        set((state) => {
          const current = state.messages[roomId] || [];
          if (current.some((m) => m.hub_msg_id === message.hub_msg_id)) return state;
          return {
            messages: { ...state.messages, [roomId]: [...current, message] },
          };
        }),

      applyRealtimeEventHint: (event) =>
        set((state) => ({
          overview: state.overview
            ? {
              ...state.overview,
              rooms: state.overview.rooms.map((room) => applyRealtimeRoomHint(room, event)),
            }
            : state.overview,
          publicRoomDetails: event.room_id && state.publicRoomDetails[event.room_id]
            ? {
              ...state.publicRoomDetails,
              [event.room_id]: applyRealtimeRoomHint(state.publicRoomDetails[event.room_id], event),
            }
            : state.publicRoomDetails,
          recentVisitedRooms: event.room_id
            ? state.recentVisitedRooms.map((room) => applyRealtimeRoomHint(room, event))
            : state.recentVisitedRooms,
        })),

      replaceOverview: (overview) => {
        set({ overview, overviewRefreshing: false, overviewErrored: false });
        useDashboardUnreadStore.getState().reconcileUnreadRooms(overview.rooms);
      },

      patchRoom: (roomId, patch) =>
        set((state) => ({
          overview: state.overview
            ? {
              ...state.overview,
              rooms: state.overview.rooms.map((room) =>
                room.room_id === roomId ? { ...room, ...patch } : room,
              ),
            }
            : state.overview,
        })),

      loadRoomMessages: async (roomId: string) => {
        if (roomMessagesInFlight.has(roomId)) return;
        set((state) => ({
          messagesLoading: { ...state.messagesLoading, [roomId]: true },
        }));
        roomMessagesInFlight.add(roomId);

        try {
          const result = await api.getRoomMessages(roomId, { limit: 50 });
          set((state) => ({
            messages: { ...state.messages, [roomId]: result.messages.reverse() },
            messagesHasMore: { ...state.messagesHasMore, [roomId]: result.has_more },
          }));
        } catch (error) {
          console.error("[ChatStore] Failed to load messages:", error);
        } finally {
          roomMessagesInFlight.delete(roomId);
          set((state) => ({
            messagesLoading: { ...state.messagesLoading, [roomId]: false },
          }));
        }
      },

      pollNewMessages: async (roomId: string, opts) => {
        if (roomPollInFlight.has(roomId)) return;
        roomPollInFlight.add(roomId);
        try {
          const existing = get().messages[roomId];

          if (!existing || existing.length === 0) {
            await get().loadRoomMessages(roomId);
          } else {
            const newestPersisted = [...existing].reverse().find(
              (m) => m.hub_msg_id && !m.hub_msg_id.startsWith("tmp_"),
            );
            if (!newestPersisted) {
              await get().loadRoomMessages(roomId);
              return;
            }
            const result = await api.getRoomMessages(roomId, { after: newestPersisted.hub_msg_id, limit: 50 });
            if (result.messages.length > 0) {
              const newMsgs = result.messages.reverse();
              set((state) => {
                const current = state.messages[roomId] || [];
                const existingIds = new Set(current.map((message) => message.hub_msg_id));
                const deduped = newMsgs.filter((message) => !existingIds.has(message.hub_msg_id));
                if (deduped.length === 0) return state;
                return {
                  messages: { ...state.messages, [roomId]: [...current, ...deduped] },
                };
              });
            }
          }
        } catch (error) {
          console.error("[ChatStore] Failed to poll new messages:", error);
        } finally {
          roomPollInFlight.delete(roomId);
        }

        const expectedHubMsgId = opts?.expectedHubMsgId ?? null;
        const retries = opts?.retries ?? 0;
        if (
          expectedHubMsgId
          && retries > 0
          && !get().hasMessage(roomId, expectedHubMsgId)
        ) {
          await new Promise((resolve) => window.setTimeout(resolve, 250));
          await get().pollNewMessages(roomId, {
            expectedHubMsgId,
            retries: retries - 1,
          });
        }
      },

      loadMoreMessages: async (roomId: string) => {
        const existing = get().messages[roomId];
        if (!existing || existing.length === 0) return;

        const oldest = existing[0];
        try {
          const result = await api.getRoomMessages(roomId, { before: oldest.hub_msg_id, limit: 50 });
          set((state) => ({
            messages: { ...state.messages, [roomId]: [...result.messages.reverse(), ...existing] },
            messagesHasMore: { ...state.messagesHasMore, [roomId]: result.has_more },
          }));
        } catch (error) {
          console.error("[ChatStore] Failed to load more messages:", error);
        }
      },

      selectAgent: async (agentId: string) => {
        const { token } = useDashboardSessionStore.getState();
        useDashboardUIStore.getState().openAgentCard();
        set({
          selectedAgentId: agentId,
          selectedAgentLoading: true,
          selectedAgentError: null,
          selectedAgentProfile: null,
          selectedAgentConversations: null,
        });
        try {
          if (token) {
            const [profile, convos] = await Promise.all([
              api.getAgentProfile(agentId),
              api.getConversations(agentId),
            ]);
            set({
              selectedAgentId: agentId,
              selectedAgentLoading: false,
              selectedAgentError: null,
              selectedAgentProfile: profile,
              selectedAgentConversations: convos.conversations,
            });
            return;
          }
          const profile = await api.getPublicAgentProfile(agentId);
          set({
            selectedAgentId: agentId,
            selectedAgentLoading: false,
            selectedAgentError: null,
            selectedAgentProfile: profile,
            selectedAgentConversations: null,
          });
        } catch (error: any) {
          console.error("[ChatStore] Failed to select agent:", error);
          set({
            selectedAgentLoading: false,
            selectedAgentError: error?.message || "Failed to load agent profile",
          });
        }
      },

      searchAgents: async (q: string) => {
        if (!q.trim()) {
          set({ searchResults: null });
          return;
        }
        const { token } = useDashboardSessionStore.getState();
        try {
          const result = token ? await api.searchAgents(q) : await api.getPublicAgents({ q });
          set({ searchResults: result.agents });
        } catch (error) {
          console.error("[ChatStore] Search failed:", error);
        }
      },

      refreshOverview: async (opts) => {
        const { token, activeAgentId } = useDashboardSessionStore.getState();
        const openedRoomId = opts?.reloadOpenedRoom
          ? useDashboardUIStore.getState().openedRoomId
          : null;

        if (!token) {
          await Promise.all([get().loadPublicRooms(), get().loadPublicAgents()]);
          return;
        }
        if (!hasReadyActiveAgent(token, activeAgentId)) {
          set({ overview: null, overviewRefreshing: false, overviewErrored: false });
          return;
        }

        set({ overviewRefreshing: true, overviewErrored: false });
        try {
          const overview = await api.getOverview();
          get().replaceOverview(overview);
          await useDashboardContactStore.getState().loadContactRequests();
          if (openedRoomId) {
            void get().loadRoomMessages(openedRoomId);
          }
        } catch (error: any) {
          set({ error: error?.message || "Failed to refresh", overviewRefreshing: false, overviewErrored: true });
        }
      },

      loadDiscoverRooms: async () => {
        set({ discoverLoading: true });
        try {
          const result = await api.discoverRooms();
          set({ discoverRooms: result.rooms, discoverLoading: false });
        } catch {
          set({ discoverLoading: false });
        }
      },

      joinRoom: async (roomId: string) => {
        const { token } = useDashboardSessionStore.getState();
        if (!token) return;
        set({ joiningRoomId: roomId });
        try {
          await api.joinRoom(roomId);
          const overview = await api.getOverview();
          set((state) => ({
            joiningRoomId: null,
            discoverRooms: state.discoverRooms.filter((room) => room.room_id !== roomId),
          }));
          get().replaceOverview(overview);
        } catch (error) {
          set({ joiningRoomId: null });
          get().setError(error instanceof Error ? error.message : "Unknown error");
        }
      },

      leaveRoom: async (roomId: string) => {
        const { token } = useDashboardSessionStore.getState();
        if (!token) return;
        set({ leavingRoomId: roomId });
        try {
          await api.leaveRoom(roomId);
          const [overview] = await Promise.all([
            api.getOverview(),
            get().loadPublicRoomDetail(roomId),
          ]);
          set({ leavingRoomId: null });
          get().replaceOverview(overview);
          void get().loadRoomMessages(roomId);
        } catch (error) {
          set({ leavingRoomId: null });
          throw error;
        }
      },

      loadPublicRooms: async () => {
        set({ publicRoomsLoading: true });
        try {
          const result = await api.getPublicRooms({ limit: 50 });
          set((state) => ({
            publicRooms: result.rooms,
            publicRoomDetails: {
              ...state.publicRoomDetails,
              ...Object.fromEntries(result.rooms.map((room) => [room.room_id, room])),
            },
            publicRoomsLoading: false,
            publicRoomsLoaded: true,
          }));
        } catch {
          set({ publicRoomsLoading: false, publicRoomsLoaded: true });
        }
      },

      loadPublicRoomDetail: async (roomId: string) => {
        const cached = get().publicRoomDetails[roomId];
        if (cached) return cached;
        try {
          const result = await api.getPublicRoom(roomId);
          const room = result.rooms[0] || null;
          if (!room) return null;
          set((state) => ({
            publicRoomDetails: {
              ...state.publicRoomDetails,
              [room.room_id]: room,
            },
            recentVisitedRooms: [
              room,
              ...state.recentVisitedRooms.filter((item) => item.room_id !== room.room_id),
            ].slice(0, 20),
          }));
          return room;
        } catch {
          return null;
        }
      },

      loadPublicAgents: async () => {
        set({ publicAgentsLoading: true });
        try {
          const result = await api.getPublicAgents({ limit: 50 });
          set({ publicAgents: result.agents, publicAgentsLoading: false, publicAgentsLoaded: true });
        } catch {
          set({ publicAgentsLoading: false, publicAgentsLoaded: true });
        }
      },

      switchActiveAgent: async (agentId: string) => {
        const { activeAgentId } = useDashboardSessionStore.getState();
        if (agentId === activeAgentId) return;
        get().bindToActiveAgent(agentId);
        useDashboardSessionStore.getState().switchActiveAgent(agentId);
        window.location.replace(window.location.pathname + window.location.search + window.location.hash);
      },
    }),
    {
      name: "dashboard-chat-storage",
      partialize: (state) => ({
        boundAgentId: state.boundAgentId,
        recentVisitedRooms: state.recentVisitedRooms,
        publicRooms: state.publicRooms,
        publicAgents: state.publicAgents,
        publicRoomDetails: state.publicRoomDetails,
      }),
    },
  ),
);
