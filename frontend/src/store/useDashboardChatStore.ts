/**
 * [INPUT]: 依赖 zustand/persist 保存 dashboard 会话与目录数据，依赖 @/lib/api 发起房间/目录/Agent 查询，依赖 session/ui/unread/contact store 提供鉴权、界面上下文与未读协调
 * [OUTPUT]: 对外提供 useDashboardChatStore，管理 overview、消息缓存、公开目录远端搜索结果、Agent 卡片数据与 chat 相关异步动作
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
  HumanAgentRoomSummary,
  PublicHumanProfile,
  PublicRoom,
  RealtimeMetaEvent,
} from "@/lib/types";
import { api, humansApi } from "@/lib/api";
import {
  buildVisibleMessageRooms,
  roomMessagesInFlight,
  roomMessagesReloadPending,
  roomPollInFlight,
  toRoomSummary,
} from "@/store/dashboard-shared";
import { useDashboardSessionStore } from "@/store/useDashboardSessionStore";
import { useDashboardUIStore } from "@/store/useDashboardUIStore";
import { useDashboardUnreadStore } from "@/store/useDashboardUnreadStore";

let publicRoomsRequestSeq = 0;
let publicAgentsRequestSeq = 0;
let publicHumansRequestSeq = 0;

function isFetchNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === "TypeError" && error.message === "Failed to fetch";
}

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

function ownedAgentRoomToDashboardRoom(room: HumanAgentRoomSummary): DashboardRoom {
  return {
    room_id: room.room_id,
    name: room.name,
    description: room.description ?? "",
    owner_id: room.owner_id,
    // ownedAgentRoomToDashboardRoom is the human-as-owner-via-bot listing —
    // these rooms are by definition agent-owned.
    owner_type: "agent",
    visibility: room.visibility,
    join_policy: room.join_policy ?? undefined,
    can_invite: undefined,
    member_count: room.member_count,
    my_role: room.bots[0]?.role ?? "member",
    created_at: room.created_at ?? null,
    rule: room.rule,
    required_subscription_product_id: room.required_subscription_product_id ?? null,
    last_viewed_at: null,
    has_unread: false,
    last_message_preview: room.last_message_preview,
    last_message_at: room.last_message_at,
    last_sender_name: room.last_sender_name,
    allow_human_send: room.allow_human_send ?? undefined,
  };
}

export function mapOwnedAgentRoomToDashboardRoom(room: HumanAgentRoomSummary): DashboardRoom {
  return ownedAgentRoomToDashboardRoom(room);
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
  publicHumans: PublicHumanProfile[];
  publicHumansLoading: boolean;
  publicHumansLoaded: boolean;
  recentVisitedRooms: PublicRoom[];
  ownedAgentRooms: HumanAgentRoomSummary[];
  ownedAgentRoomsLoading: boolean;
  ownedAgentRoomsLoaded: boolean;

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
  loadPublicRooms: (q?: string) => Promise<void>;
  loadPublicRoomDetail: (roomId: string) => Promise<PublicRoom | null>;
  loadPublicAgents: (q?: string) => Promise<void>;
  loadPublicHumans: (q?: string) => Promise<void>;
  loadOwnedAgentRooms: () => Promise<void>;
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
  publicHumans: [],
  publicHumansLoading: false,
  publicHumansLoaded: false,
  recentVisitedRooms: [],
  ownedAgentRooms: [],
  ownedAgentRoomsLoading: false,
  ownedAgentRoomsLoaded: false,
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
    || state.ownedAgentRoomsLoading
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
        set({ ...initialChatState }),

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
        if (recentRoom) return toRoomSummary(recentRoom);
        const ownedAgentRoom = state.ownedAgentRooms.find((room) => room.room_id === roomId);
        return ownedAgentRoom ? ownedAgentRoomToDashboardRoom(ownedAgentRoom) : null;
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
          ownedAgentRooms: event.room_id
            ? state.ownedAgentRooms.map((room) => applyRealtimeRoomHint(room, event))
            : state.ownedAgentRooms,
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
        if (roomMessagesInFlight.has(roomId)) {
          roomMessagesReloadPending.add(roomId);
          return;
        }
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
          if (roomMessagesReloadPending.delete(roomId)) {
            void get().loadRoomMessages(roomId);
          }
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
                const currentWithoutMatchedOptimistic = current.filter((message) => {
                  if (!message.hub_msg_id?.startsWith("tmp_")) return true;
                  return !deduped.some((newMessage) =>
                    newMessage.text === message.text
                    && (
                      newMessage.sender_id === message.sender_id
                      || newMessage.is_mine === message.is_mine
                    ),
                  );
                });
                return {
                  messages: { ...state.messages, [roomId]: [...currentWithoutMatchedOptimistic, ...deduped] },
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
        useDashboardUIStore.getState().openAgentCard();
        set({
          selectedAgentId: agentId,
          selectedAgentLoading: true,
          selectedAgentError: null,
          selectedAgentProfile: null,
          selectedAgentConversations: null,
        });
        try {
          const result = await api.getAgentCard(agentId);
          set({
            selectedAgentId: agentId,
            selectedAgentLoading: false,
            selectedAgentError: null,
            selectedAgentProfile: result.profile,
            selectedAgentConversations: result.conversations,
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
        try {
          const agents = await api.searchAgentDirectory(q);
          set({ searchResults: agents });
        } catch (error) {
          console.error("[ChatStore] Search failed:", error);
        }
      },

      refreshOverview: async (opts) => {
        const { token } = useDashboardSessionStore.getState();
        const openedRoomId = opts?.reloadOpenedRoom
          ? useDashboardUIStore.getState().openedRoomId
          : null;

        if (!token) {
          await Promise.all([get().loadPublicRooms(), get().loadPublicAgents()]);
          return;
        }
        // Human-first: /overview works for both Agent viewer (X-Active-Agent
        // header) and Human viewer (derived from Supabase JWT). The backend
        // decides; we just need a valid token.

        set({ overviewRefreshing: true, overviewErrored: false });
        try {
          const overview = await api.getOverview();
          get().replaceOverview(overview);
          if (openedRoomId) {
            void get().loadRoomMessages(openedRoomId);
          }
        } catch (error: any) {
          if (get().overview && isFetchNetworkError(error)) {
            console.warn("[ChatStore] Background overview refresh failed:", error);
            set({ overviewRefreshing: false, overviewErrored: false });
            return;
          }
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

      loadPublicRooms: async (q = "") => {
        const requestId = ++publicRoomsRequestSeq;
        set({ publicRoomsLoading: true });
        try {
          const result = await api.getPublicRooms({ q: q.trim() || undefined, limit: 50 });
          if (requestId !== publicRoomsRequestSeq) return;
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
          if (requestId !== publicRoomsRequestSeq) return;
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

      loadPublicAgents: async (q = "") => {
        const requestId = ++publicAgentsRequestSeq;
        set({ publicAgentsLoading: true });
        try {
          const result = await api.getPublicAgents({ q: q.trim() || undefined, limit: 50 });
          if (requestId !== publicAgentsRequestSeq) return;
          set({ publicAgents: result.agents, publicAgentsLoading: false, publicAgentsLoaded: true });
        } catch {
          if (requestId !== publicAgentsRequestSeq) return;
          set({ publicAgentsLoading: false, publicAgentsLoaded: true });
        }
      },

      loadPublicHumans: async (q = "") => {
        const requestId = ++publicHumansRequestSeq;
        set({ publicHumansLoading: true });
        try {
          const result = await api.getPublicHumans({ q: q.trim() || undefined, limit: 100 });
          if (requestId !== publicHumansRequestSeq) return;
          set({ publicHumans: result.humans, publicHumansLoading: false, publicHumansLoaded: true });
        } catch {
          if (requestId !== publicHumansRequestSeq) return;
          set({ publicHumansLoading: false, publicHumansLoaded: true });
        }
      },

      loadOwnedAgentRooms: async () => {
        const { token, activeIdentity } = useDashboardSessionStore.getState();
        if (!token || activeIdentity?.type !== "human") {
          set({ ownedAgentRooms: [], ownedAgentRoomsLoading: false, ownedAgentRoomsLoaded: true });
          return;
        }
        set({ ownedAgentRoomsLoading: true });
        try {
          const result = await humansApi.listAgentRooms();
          set({
            ownedAgentRooms: result.rooms,
            ownedAgentRoomsLoading: false,
            ownedAgentRoomsLoaded: true,
          });
        } catch (error) {
          set({
            ownedAgentRoomsLoading: false,
            ownedAgentRoomsLoaded: true,
          });
          get().setError(error instanceof Error ? error.message : "Failed to load bot rooms");
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
