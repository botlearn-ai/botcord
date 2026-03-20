/**
 * [INPUT]: 依赖 zustand/persist 保存频道域状态，依赖 @/lib/api 发起房间、消息、探索相关请求，依赖 session/contact store 提供鉴权上下文与联系人刷新
 * [OUTPUT]: 对外提供 useDashboardChannelStore 状态仓库与频道域异步动作
 * [POS]: frontend dashboard 的 channel 主域状态源，负责房间、消息、探索、公开频道与右侧资料面板
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
  TopicInfo,
} from "@/lib/types";
import { api, getActiveAgentId } from "@/lib/api";
import { useDashboardContactStore } from "@/store/useDashboardContactStore";
import { useDashboardSessionStore } from "@/store/useDashboardSessionStore";

const roomMessagesInFlight = new Set<string>();
const roomPollInFlight = new Set<string>();

type ReadableRoomResourceOptions<T> = {
  canUseMemberView: boolean;
  loadMember: () => Promise<T>;
  loadPublic: () => Promise<T>;
  onSuccess: (value: T) => void;
  onPublicError?: (error: unknown) => void;
  onMemberError?: (error: unknown) => void;
};

async function loadReadableRoomResource<T>({
  canUseMemberView,
  loadMember,
  loadPublic,
  onSuccess,
  onPublicError,
  onMemberError,
}: ReadableRoomResourceOptions<T>): Promise<void> {
  if (!canUseMemberView) {
    try {
      onSuccess(await loadPublic());
    } catch (error) {
      onPublicError?.(error);
    }
    return;
  }

  try {
    onSuccess(await loadMember());
    return;
  } catch (error: any) {
    if (error?.status !== 403) {
      onMemberError?.(error);
      return;
    }
  }

  try {
    onSuccess(await loadPublic());
  } catch (error) {
    onPublicError?.(error);
  }
}

function toRoomSummary(room: PublicRoom): DashboardRoom {
  return {
    room_id: room.room_id,
    name: room.name,
    description: room.description,
    owner_id: room.owner_id,
    visibility: room.visibility,
    member_count: room.member_count,
    my_role: "viewer",
    rule: room.rule ?? null,
    required_subscription_product_id: room.required_subscription_product_id,
    last_message_preview: room.last_message_preview,
    last_message_at: room.last_message_at,
    last_sender_name: room.last_sender_name,
  };
}

function hasReadyActiveAgent(token: string | null, activeAgentId?: string | null): activeAgentId is string {
  return Boolean(token && (activeAgentId || getActiveAgentId()));
}

function buildVisibleMessageRooms(state: Pick<DashboardChannelState, "overview" | "recentVisitedRooms"> & { token: string | null }): DashboardRoom[] {
  const joinedRooms = state.overview?.rooms || [];
  const joinedRoomIds = new Set(joinedRooms.map((room) => room.room_id));
  const recentUnjoinedRooms = state.recentVisitedRooms
    .filter((room) => !joinedRoomIds.has(room.room_id))
    .map(toRoomSummary);
  const mergedRooms = [...joinedRooms, ...recentUnjoinedRooms].sort((a, b) => {
    const aTs = a.last_message_at ? Date.parse(a.last_message_at) : 0;
    const bTs = b.last_message_at ? Date.parse(b.last_message_at) : 0;
    return bTs - aTs;
  });
  return state.token ? mergedRooms : state.recentVisitedRooms.map(toRoomSummary);
}

interface DashboardChannelState {
  overviewRefreshing: boolean;
  overview: DashboardOverview | null;
  focusedRoomId: string | null;
  openedRoomId: string | null;
  messages: Record<string, DashboardMessage[]>;
  messagesLoading: Record<string, boolean>;
  messagesHasMore: Record<string, boolean>;
  topics: Record<string, TopicInfo[]>;
  error: string | null;
  rightPanelOpen: boolean;
  selectedAgentId: string | null;
  selectedAgentProfile: AgentProfile | null;
  selectedAgentConversations: DashboardRoom[] | null;
  searchResults: AgentProfile[] | null;
  sidebarTab: "messages" | "contacts" | "explore" | "wallet";
  exploreView: "rooms" | "agents";
  contactsView: "agents" | "requests" | "rooms";
  discoverRooms: DiscoverRoom[];
  discoverLoading: boolean;
  joiningRoomId: string | null;
  publicRooms: PublicRoom[];
  publicRoomDetails: Record<string, PublicRoom>;
  publicRoomsLoading: boolean;
  publicAgents: AgentProfile[];
  publicAgentsLoading: boolean;
  recentVisitedRooms: PublicRoom[];

  setFocusedRoomId: (roomId: string | null) => void;
  setOpenedRoomId: (roomId: string | null) => void;
  setSidebarTab: (tab: DashboardChannelState["sidebarTab"]) => void;
  setExploreView: (view: DashboardChannelState["exploreView"]) => void;
  setContactsView: (view: DashboardChannelState["contactsView"]) => void;
  toggleRightPanel: () => void;
  addRecentPublicRoom: (room: PublicRoom) => void;
  setError: (error: string | null) => void;
  resetChannelState: () => void;
  logout: () => void;
  getRoomSummary: (roomId: string) => DashboardRoom | null;
  getVisibleMessageRooms: () => DashboardRoom[];

  loadRoomMessages: (roomId: string) => Promise<void>;
  pollNewMessages: (roomId: string) => Promise<void>;
  loadMoreMessages: (roomId: string) => Promise<void>;
  selectAgent: (agentId: string) => Promise<void>;
  searchAgents: (q: string) => Promise<void>;
  refreshOverview: () => Promise<void>;
  loadDiscoverRooms: () => Promise<void>;
  joinRoom: (roomId: string) => Promise<void>;
  loadPublicRooms: () => Promise<void>;
  loadPublicRoomDetail: (roomId: string) => Promise<PublicRoom | null>;
  loadPublicAgents: () => Promise<void>;
  loadTopics: (roomId: string) => Promise<void>;
  switchActiveAgent: (agentId: string) => Promise<void>;
}

const initialState = {
  overviewRefreshing: false,
  overview: null,
  focusedRoomId: null,
  openedRoomId: null,
  messages: {},
  messagesLoading: {},
  messagesHasMore: {},
  topics: {},
  error: null,
  rightPanelOpen: false,
  selectedAgentId: null,
  selectedAgentProfile: null,
  selectedAgentConversations: null,
  searchResults: null,
  sidebarTab: "messages" as const,
  exploreView: "rooms" as const,
  contactsView: "agents" as const,
  discoverRooms: [],
  discoverLoading: false,
  joiningRoomId: null,
  publicRooms: [],
  publicRoomDetails: {},
  publicRoomsLoading: false,
  publicAgents: [],
  publicAgentsLoading: false,
  recentVisitedRooms: [],
};

function hasTransientChannelState(state: DashboardChannelState): boolean {
  return (
    state.overviewRefreshing
    || state.overview !== null
    || state.focusedRoomId !== null
    || state.openedRoomId !== null
    || Object.keys(state.messages).length > 0
    || Object.keys(state.messagesLoading).length > 0
    || Object.keys(state.messagesHasMore).length > 0
    || Object.keys(state.topics).length > 0
    || state.error !== null
    || state.rightPanelOpen
    || state.selectedAgentId !== null
    || state.selectedAgentProfile !== null
    || state.selectedAgentConversations !== null
    || state.searchResults !== null
    || state.discoverRooms.length > 0
    || state.discoverLoading
    || state.joiningRoomId !== null
    || state.publicRoomsLoading
    || state.publicAgentsLoading
  );
}

export const useDashboardChannelStore = create<DashboardChannelState>()(
  persist(
    (set, get) => ({
      ...initialState,

      setFocusedRoomId: (roomId) =>
        set((state) => (state.focusedRoomId === roomId ? state : { focusedRoomId: roomId })),
      setOpenedRoomId: (roomId) =>
        set((state) => (state.openedRoomId === roomId ? state : { openedRoomId: roomId })),
      setSidebarTab: (tab) =>
        set((state) => (state.sidebarTab === tab ? state : { sidebarTab: tab })),
      setExploreView: (view) =>
        set((state) => (state.exploreView === view ? state : { exploreView: view })),
      setContactsView: (view) =>
        set((state) => (state.contactsView === view ? state : { contactsView: view })),
      toggleRightPanel: () => set((state) => ({ rightPanelOpen: !state.rightPanelOpen })),
      setError: (error) => set({ error }),

      addRecentPublicRoom: (room) =>
        set((state) => ({
          recentVisitedRooms: [
            room,
            ...state.recentVisitedRooms.filter((item) => item.room_id !== room.room_id),
          ].slice(0, 20),
        })),

      resetChannelState: () =>
        set((state) => {
          if (!hasTransientChannelState(state)) {
            return state;
          }
          return {
            ...initialState,
            sidebarTab: state.sidebarTab,
            exploreView: state.exploreView,
            contactsView: state.contactsView,
            recentVisitedRooms: state.recentVisitedRooms,
            publicRooms: state.publicRooms,
            publicAgents: state.publicAgents,
            publicRoomDetails: state.publicRoomDetails,
          };
        }),

      logout: () =>
        set({
          ...initialState,
          recentVisitedRooms: get().recentVisitedRooms,
          publicRooms: get().publicRooms,
          publicAgents: get().publicAgents,
          publicRoomDetails: get().publicRoomDetails,
          sidebarTab: "messages",
        }),

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

      loadRoomMessages: async (roomId: string) => {
        if (roomMessagesInFlight.has(roomId)) return;
        set((state) => ({
          messagesLoading: { ...state.messagesLoading, [roomId]: true },
        }));
        roomMessagesInFlight.add(roomId);

        const { token, activeAgentId } = useDashboardSessionStore.getState();
        const canUseAuthedMessages = hasReadyActiveAgent(token, activeAgentId);
        try {
          await loadReadableRoomResource({
            canUseMemberView: canUseAuthedMessages,
            loadMember: () => api.getRoomMessages(roomId, { limit: 50 }),
            loadPublic: () => api.getPublicRoomMessages(roomId, { limit: 50 }),
            onSuccess: (result) => {
              set((state) => ({
                messages: { ...state.messages, [roomId]: result.messages.reverse() },
                messagesHasMore: { ...state.messagesHasMore, [roomId]: result.has_more },
              }));
            },
            onMemberError: (error) => {
              console.error("[ChannelStore] Failed to load messages:", error);
            },
            onPublicError: (error) => {
              console.error("[ChannelStore] Failed to load messages:", error);
            },
          });
        } finally {
          roomMessagesInFlight.delete(roomId);
          set((state) => ({
            messagesLoading: { ...state.messagesLoading, [roomId]: false },
          }));
        }
      },

      pollNewMessages: async (roomId: string) => {
        if (roomPollInFlight.has(roomId)) return;
        roomPollInFlight.add(roomId);

        const { token, activeAgentId } = useDashboardSessionStore.getState();
        const canUseAuthedMessages = hasReadyActiveAgent(token, activeAgentId);
        const existing = get().messages[roomId];

        // Empty room: reload from scratch to pick up the first message
        if (!existing || existing.length === 0) {
          try {
            await get().loadRoomMessages(roomId);
          } finally {
            roomPollInFlight.delete(roomId);
          }
          return;
        }

        const newest = existing[existing.length - 1];
        try {
          await loadReadableRoomResource({
            canUseMemberView: canUseAuthedMessages,
            loadMember: () => api.getRoomMessages(roomId, { after: newest.hub_msg_id, limit: 50 }),
            loadPublic: () => api.getPublicRoomMessages(roomId, { after: newest.hub_msg_id, limit: 50 }),
            onSuccess: (result) => {
              if (result.messages.length === 0) return;
              // API returns descending order; reverse to chronological
              const newMsgs = result.messages.reverse();
              set((state) => {
                const current = state.messages[roomId] || [];
                const existingIds = new Set(current.map((m) => m.hub_msg_id));
                const deduped = newMsgs.filter((m) => !existingIds.has(m.hub_msg_id));
                if (deduped.length === 0) return state;
                return {
                  messages: { ...state.messages, [roomId]: [...current, ...deduped] },
                };
              });
              // Refresh topics if any new message has a topic
              if (newMsgs.some((m) => m.topic_id)) {
                get().loadTopics(roomId);
              }
            },
            onMemberError: (error) => {
              console.error("[ChannelStore] Failed to poll new messages:", error);
            },
            onPublicError: (error) => {
              console.error("[ChannelStore] Failed to poll new messages:", error);
            },
          });
        } catch (err) {
          console.error("[ChannelStore] Failed to poll new messages:", err);
        } finally {
          roomPollInFlight.delete(roomId);
        }
      },

      loadMoreMessages: async (roomId: string) => {
        const { token, activeAgentId } = useDashboardSessionStore.getState();
        const { messages } = get();
        const canUseAuthedMessages = hasReadyActiveAgent(token, activeAgentId);
        const existing = messages[roomId];
        if (!existing || existing.length === 0) return;

        const oldest = existing[0];
        try {
          await loadReadableRoomResource({
            canUseMemberView: canUseAuthedMessages,
            loadMember: () => api.getRoomMessages(roomId, { before: oldest.hub_msg_id, limit: 50 }),
            loadPublic: () => api.getPublicRoomMessages(roomId, { before: oldest.hub_msg_id, limit: 50 }),
            onSuccess: (result) => {
              set((state) => ({
                messages: { ...state.messages, [roomId]: [...result.messages.reverse(), ...existing] },
                messagesHasMore: { ...state.messagesHasMore, [roomId]: result.has_more },
              }));
            },
            onMemberError: (error) => {
              console.error("[ChannelStore] Failed to load more messages:", error);
            },
            onPublicError: (error) => {
              console.error("[ChannelStore] Failed to load more messages:", error);
            },
          });
        } catch (err) {
          console.error("[ChannelStore] Failed to load more messages:", err);
        }
      },

      selectAgent: async (agentId: string) => {
        const { token } = useDashboardSessionStore.getState();
        try {
          if (token) {
            const [profile, convos] = await Promise.all([
              api.getAgentProfile(agentId),
              api.getConversations(agentId),
            ]);
            set({
              selectedAgentId: agentId,
              selectedAgentProfile: profile,
              selectedAgentConversations: convos.conversations,
              rightPanelOpen: true,
            });
          } else {
            const profile = await api.getPublicAgentProfile(agentId);
            set({
              selectedAgentId: agentId,
              selectedAgentProfile: profile,
              selectedAgentConversations: null,
              rightPanelOpen: true,
            });
          }
        } catch (err) {
          console.error("[ChannelStore] Failed to select agent:", err);
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
        } catch (err) {
          console.error("[ChannelStore] Search failed:", err);
        }
      },

      refreshOverview: async () => {
        const { token, activeAgentId } = useDashboardSessionStore.getState();
        const { openedRoomId } = get();
        if (!token) {
          await Promise.all([get().loadPublicRooms(), get().loadPublicAgents()]);
          return;
        }
        if (!hasReadyActiveAgent(token, activeAgentId)) {
          set({ overview: null, overviewRefreshing: false });
          return;
        }

        set({ overviewRefreshing: true });
        try {
          const overview = await api.getOverview();
          set({ overview, overviewRefreshing: false });
          await useDashboardContactStore.getState().loadContactRequests();
          if (openedRoomId) {
            void get().loadRoomMessages(openedRoomId);
          }
        } catch (err: any) {
          set({ error: err.message || "Failed to refresh", overviewRefreshing: false });
        }
      },

      loadDiscoverRooms: async () => {
        const { token } = useDashboardSessionStore.getState();
        if (!token) return;
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
        const { discoverRooms } = get();
        if (!token) return;
        set({ joiningRoomId: roomId });
        try {
          await api.joinRoom(roomId);
          const overview = await api.getOverview();
          set({
            overview,
            joiningRoomId: null,
            discoverRooms: discoverRooms.filter((room) => room.room_id !== roomId),
          });
        } catch {
          set({ joiningRoomId: null });
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
          }));
        } catch {
          set({ publicRoomsLoading: false });
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
          set({ publicAgents: result.agents, publicAgentsLoading: false });
        } catch {
          set({ publicAgentsLoading: false });
        }
      },

      loadTopics: async (roomId: string) => {
        const { token, activeAgentId } = useDashboardSessionStore.getState();
        const resolvedAgentId = activeAgentId || getActiveAgentId();
        const canUseMemberView = Boolean(token && resolvedAgentId);
        await loadReadableRoomResource({
          canUseMemberView,
          loadMember: () => api.getTopics(token!, roomId),
          loadPublic: () => api.getPublicTopics(roomId),
          onSuccess: (result) => {
            set((state) => ({ topics: { ...state.topics, [roomId]: result.topics } }));
          },
          onMemberError: (error) => {
            console.error("[ChannelStore] Failed to load topics:", error);
          },
          onPublicError: (error) => {
            console.error("[ChannelStore] Failed to load public topics:", error);
            set((state) => ({ topics: { ...state.topics, [roomId]: [] } }));
          },
        });
      },

      switchActiveAgent: async (agentId: string) => {
        const { token } = useDashboardSessionStore.getState();
        useDashboardSessionStore.getState().switchActiveAgent(agentId);
        if (!token) return;

        set({ overviewRefreshing: true });
        try {
          const overview = await api.getOverview();
          set({ overview, overviewRefreshing: false });
          await useDashboardContactStore.getState().loadContactRequests();
        } catch (err: any) {
          set({ error: err.message, overviewRefreshing: false });
        }
      },
    }),
    {
      name: "dashboard-storage",
      partialize: (state) => ({
        recentVisitedRooms: state.recentVisitedRooms,
      }),
    },
  ),
);
