/**
 * [INPUT]: 依赖 zustand/persist 保存 dashboard 会话状态，依赖 @/lib/api 与 active-agent 工具发起 BFF 请求
 * [OUTPUT]: 对外提供 useDashboardStore 状态仓库与 dashboard 异步动作
 * [POS]: frontend dashboard 的单一状态源，协调登录态、活跃 agent、房间消息、联系人与钱包数据
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type {
  DashboardOverview, DashboardMessage, AgentProfile, DashboardRoom, 
  DiscoverRoom, PublicRoom, TopicInfo, WalletSummary, WalletLedgerEntry,
  WithdrawalResponse, UserProfile, UserAgent, ContactRequestItem
} from "@/lib/types";
import { api, userApi, getActiveAgentId, setActiveAgentId } from "@/lib/api";

const roomMessagesInFlight = new Set<string>();
let authInitRequestId = 0;

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

function buildVisibleMessageRooms(state: Pick<DashboardState, "overview" | "recentVisitedRooms" | "token">): DashboardRoom[] {
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

export type DashboardSessionMode = "guest" | "authed-no-agent" | "authed-ready";

function resolveStoredActiveAgentId(user: UserProfile): string | null {
  const savedAgentId = getActiveAgentId();
  if (savedAgentId && user.agents.some((agent) => agent.agent_id === savedAgentId)) {
    return savedAgentId;
  }
  const defaultAgent = user.agents.find((agent) => agent.is_default) || user.agents[0];
  return defaultAgent?.agent_id ?? null;
}

function hasReadyActiveAgent(token: string | null, activeAgentId?: string | null): activeAgentId is string {
  return Boolean(token && (activeAgentId || getActiveAgentId()));
}

function resolveSessionMode(token: string | null, activeAgentId: string | null): DashboardSessionMode {
  if (!token) return "guest";
  return activeAgentId ? "authed-ready" : "authed-no-agent";
}

interface DashboardState {
  authResolved: boolean;
  authBootstrapping: boolean;
  overviewRefreshing: boolean;
  sessionMode: DashboardSessionMode;
  token: string | null;
  user: UserProfile | null;
  ownedAgents: UserAgent[];
  activeAgentId: string | null;
  overview: DashboardOverview | null;
  focusedRoomId: string | null;
  openedRoomId: string | null;
  messages: Record<string, DashboardMessage[]>;
  messagesLoading: Record<string, boolean>;
  messagesHasMore: Record<string, boolean>;
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
  topics: Record<string, TopicInfo[]>;
  publicRooms: PublicRoom[];
  publicRoomDetails: Record<string, PublicRoom>;
  publicRoomsLoading: boolean;
  publicAgents: AgentProfile[];
  publicAgentsLoading: boolean;
  wallet: WalletSummary | null;
  walletLedger: WalletLedgerEntry[];
  walletLedgerHasMore: boolean;
  walletLedgerCursor: string | null;
  walletLoading: boolean;
  walletError: string | null;
  walletLedgerError: string | null;
  withdrawalRequests: WithdrawalResponse[];
  withdrawalRequestsLoading: boolean;
  withdrawalRequestsError: string | null;
  withdrawalRequestsLoaded: boolean;
  walletView: 'overview' | 'ledger';
  recentVisitedRooms: PublicRoom[];
  pendingFriendRequests: string[];
  contactRequestsReceived: ContactRequestItem[];
  contactRequestsSent: ContactRequestItem[];
  contactRequestsLoading: boolean;
  processingContactRequestId: number | null;
  sendingContactRequest: boolean;

  // Actions
  setAuthResolved: (resolved: boolean) => void;
  setToken: (token: string | null) => void;
  setUser: (user: UserProfile) => void;
  setActiveAgentId: (agentId: string | null) => void;
  setFocusedRoomId: (roomId: string | null) => void;
  setOpenedRoomId: (roomId: string | null) => void;
  setSidebarTab: (tab: DashboardState['sidebarTab']) => void;
  setExploreView: (view: DashboardState['exploreView']) => void;
  setContactsView: (view: DashboardState['contactsView']) => void;
  toggleRightPanel: () => void;
  setWalletView: (view: DashboardState['walletView']) => void;
  addRecentPublicRoom: (room: PublicRoom) => void;
  markFriendRequestPending: (agentId: string) => void;
  setError: (error: string | null) => void;
  logout: () => void;
  getRoomSummary: (roomId: string) => DashboardRoom | null;
  getVisibleMessageRooms: () => DashboardRoom[];

  // Async Actions
  loadRoomMessages: (roomId: string) => Promise<void>;
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
  loadWallet: () => Promise<void>;
  loadWalletLedger: (loadMore?: boolean) => Promise<void>;
  loadWithdrawalRequests: () => Promise<void>;
  switchActiveAgent: (agentId: string) => Promise<void>;
  refreshUserProfile: () => Promise<void>;
  initAuth: (token: string) => Promise<void>;
  loadContactRequests: () => Promise<void>;
  sendContactRequest: (toAgentId: string, message?: string) => Promise<void>;
  respondContactRequest: (requestId: number, action: 'accept' | 'reject') => Promise<void>;
}

const initialState = {
  authResolved: false,
  authBootstrapping: false,
  overviewRefreshing: false,
  token: null,
  sessionMode: "guest" as const,
  user: null,
  ownedAgents: [],
  activeAgentId: null,
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
  wallet: null,
  walletLedger: [],
  walletLedgerHasMore: false,
  walletLedgerCursor: null,
  walletLoading: false,
  walletError: null,
  walletLedgerError: null,
  withdrawalRequests: [],
  withdrawalRequestsLoading: false,
  withdrawalRequestsError: null,
  withdrawalRequestsLoaded: false,
  walletView: 'overview' as const,
  recentVisitedRooms: [],
  pendingFriendRequests: [],
  contactRequestsReceived: [],
  contactRequestsSent: [],
  contactRequestsLoading: false,
  processingContactRequestId: null,
  sendingContactRequest: false,
};

export const useDashboardStore = create<DashboardState>()(
  persist(
    (set, get) => ({
      ...initialState,

      setAuthResolved: (authResolved) => set({ authResolved }),

      setToken: (token) => {
        if (!token) {
          authInitRequestId += 1;
          setActiveAgentId(null);
          set({
            ...initialState,
            authResolved: true,
            authBootstrapping: false,
            recentVisitedRooms: get().recentVisitedRooms,
            pendingFriendRequests: get().pendingFriendRequests,
            publicRooms: get().publicRooms,
            publicAgents: get().publicAgents,
            publicRoomDetails: get().publicRoomDetails,
            sidebarTab: "messages",
          });
          return;
        }

        const activeAgentId = get().activeAgentId || getActiveAgentId();
        set({
          authResolved: true,
          authBootstrapping: false,
          overviewRefreshing: false,
          token,
          activeAgentId,
          sessionMode: resolveSessionMode(token, activeAgentId),
          error: null,
        });
        if (token) {
          set({ sidebarTab: 'messages' });
        }
      },

      setUser: (user) => set((state) => ({ user, ownedAgents: user.agents, sessionMode: resolveSessionMode(state.token, state.activeAgentId) })),

      setActiveAgentId: (agentId) => set((state) => ({
        activeAgentId: agentId,
        sessionMode: resolveSessionMode(state.token, agentId),
      })),

      setFocusedRoomId: (roomId) => set({ focusedRoomId: roomId }),
      setOpenedRoomId: (roomId) => set({ openedRoomId: roomId }),

      setSidebarTab: (tab) => set({ sidebarTab: tab }),

      setExploreView: (view) => set({ exploreView: view }),
      setContactsView: (view) => set({ contactsView: view }),

      toggleRightPanel: () => set((state) => ({ rightPanelOpen: !state.rightPanelOpen })),

      setWalletView: (view) => set({ walletView: view }),

      addRecentPublicRoom: (room) =>
        set((state) => {
          const next = [
            room,
            ...state.recentVisitedRooms.filter((item) => item.room_id !== room.room_id),
          ].slice(0, 20);
          return { recentVisitedRooms: next };
        }),

      markFriendRequestPending: (agentId) =>
        set((state) => ({
          pendingFriendRequests: state.pendingFriendRequests.includes(agentId)
            ? state.pendingFriendRequests
            : [...state.pendingFriendRequests, agentId],
        })),

      setError: (error) => set({ error }),

      logout: () => {
        setActiveAgentId(null);
        set({
          ...initialState,
          authResolved: true,
          recentVisitedRooms: get().recentVisitedRooms,
          pendingFriendRequests: get().pendingFriendRequests,
          publicRooms: get().publicRooms,
          publicAgents: get().publicAgents,
          sidebarTab: "messages",
        });
      },

      getRoomSummary: (roomId) => {
        const state = get();
        const joinedRoom = state.overview?.rooms.find((room) => room.room_id === roomId);
        if (joinedRoom) {
          return joinedRoom;
        }
        const publicRoom = state.publicRooms.find((room) => room.room_id === roomId)
          || state.publicRoomDetails[roomId];
        if (publicRoom) {
          return toRoomSummary(publicRoom);
        }
        const recentRoom = state.recentVisitedRooms.find((room) => room.room_id === roomId);
        return recentRoom ? toRoomSummary(recentRoom) : null;
      },

      getVisibleMessageRooms: () => buildVisibleMessageRooms(get()),

  // Async Actions
      initAuth: async (token: string) => {
    const requestId = ++authInitRequestId;
    const current = get();
    const shouldShowBootstrap = !current.authResolved;

    set({
      authResolved: shouldShowBootstrap ? false : current.authResolved,
      authBootstrapping: shouldShowBootstrap,
      token,
      error: null,
    });
    
    try {
      const user = await userApi.getMe();
      if (requestId !== authInitRequestId) {
        return;
      }
      const activeId = resolveStoredActiveAgentId(user);
      set({
        authResolved: true,
        user,
        ownedAgents: user.agents,
        activeAgentId: activeId,
        sessionMode: resolveSessionMode(token, activeId),
        overview: activeId ? get().overview : null,
        wallet: activeId ? get().wallet : null,
        walletLedger: activeId ? get().walletLedger : [],
        walletLedgerCursor: activeId ? get().walletLedgerCursor : null,
        walletLedgerHasMore: activeId ? get().walletLedgerHasMore : false,
        walletError: null,
        walletLedgerError: null,
        overviewRefreshing: false,
      });

      setActiveAgentId(activeId);

      if (activeId) {
        const [overview, wallet, withdrawalsResult] = await Promise.all([
          api.getOverview(),
          api.getWallet().catch(() => null),
          api.getWithdrawals()
            .then((result) => ({ withdrawals: result.withdrawals, error: null }))
            .catch((err: any) => ({
              withdrawals: [],
              error: err.message || "Failed to load withdrawals",
            }))
        ]);
        if (requestId !== authInitRequestId) {
          return;
        }
        set({
          authResolved: true,
          authBootstrapping: false,
          overview,
          wallet,
          withdrawalRequests: withdrawalsResult.withdrawals,
          withdrawalRequestsError: withdrawalsResult.error,
          withdrawalRequestsLoaded: true,
        });
        await get().loadContactRequests();
      } else {
        if (requestId !== authInitRequestId) {
          return;
        }
        set({ authResolved: true, authBootstrapping: false });
      }
    } catch (err: any) {
      if (requestId !== authInitRequestId) {
        return;
      }
      if (err?.status === 401 || err?.status === 403) {
        setActiveAgentId(null);
        set({
          ...initialState,
          authResolved: true,
          authBootstrapping: false,
          recentVisitedRooms: get().recentVisitedRooms,
          pendingFriendRequests: get().pendingFriendRequests,
          publicRooms: get().publicRooms,
          publicAgents: get().publicAgents,
          publicRoomDetails: get().publicRoomDetails,
          sidebarTab: "messages",
        });
        return;
      }
      console.warn("[Store] User profile unavailable, forcing agent gate:", err.message);
      setActiveAgentId(null);
      set({
        authResolved: true,
        authBootstrapping: false,
        user: null,
        ownedAgents: [],
        activeAgentId: null,
        sessionMode: "authed-no-agent",
        overview: null,
        wallet: null,
        walletLedger: [],
        walletLedgerCursor: null,
        walletLedgerHasMore: false,
        walletError: null,
        walletLedgerError: null,
        withdrawalRequests: [],
        withdrawalRequestsLoaded: false,
        error: null,
      });
    }
  },

  loadRoomMessages: async (roomId: string) => {
    if (roomMessagesInFlight.has(roomId)) {
      return;
    }
    set((state) => ({
      messagesLoading: { ...state.messagesLoading, [roomId]: true },
    }));
    roomMessagesInFlight.add(roomId);
    const { token, activeAgentId } = get();
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
          console.error("[Store] Failed to load messages:", error);
        },
        onPublicError: (error) => {
          console.error("[Store] Failed to load messages:", error);
        },
      });
    } catch (err) {
      console.error("[Store] Failed to load messages:", err);
    } finally {
      roomMessagesInFlight.delete(roomId);
      set((state) => ({
        messagesLoading: { ...state.messagesLoading, [roomId]: false },
      }));
    }
  },

  loadMoreMessages: async (roomId: string) => {
    const { token, activeAgentId, messages } = get();
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
          console.error("[Store] Failed to load more messages:", error);
        },
        onPublicError: (error) => {
          console.error("[Store] Failed to load more messages:", error);
        },
      });
    } catch (err) {
      console.error("[Store] Failed to load more messages:", err);
    }
  },

  selectAgent: async (agentId: string) => {
    const { token } = get();
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
      console.error("[Store] Failed to select agent:", err);
    }
  },

  searchAgents: async (q: string) => {
    if (!q.trim()) {
      set({ searchResults: null });
      return;
    }
    const { token } = get();
    try {
      const result = token
        ? await api.searchAgents(q)
        : await api.getPublicAgents({ q });
      set({ searchResults: result.agents });
    } catch (err) {
      console.error("[Store] Search failed:", err);
    }
  },

  refreshOverview: async () => {
    const { token, openedRoomId, activeAgentId } = get();
    if (!token) {
      const store = get();
      await Promise.all([store.loadPublicRooms(), store.loadPublicAgents()]);
      return;
    }
    if (!hasReadyActiveAgent(token, activeAgentId)) {
      set({
        activeAgentId: null,
        sessionMode: "authed-no-agent",
        overview: null,
        wallet: null,
        walletLedger: [],
        walletLedgerCursor: null,
        walletLedgerHasMore: false,
        walletError: null,
        walletLedgerError: null,
        overviewRefreshing: false,
      });
      return;
    }

    set({ overviewRefreshing: true });
    try {
      const overview = await api.getOverview();
      set({ overview, overviewRefreshing: false });
      await get().loadContactRequests();
      if (openedRoomId) {
        get().loadRoomMessages(openedRoomId);
      }
    } catch (err: any) {
      set({ error: err.message || "Failed to refresh", overviewRefreshing: false });
    }
  },

  loadDiscoverRooms: async () => {
    const { token } = get();
    if (!token) return;
    set({ discoverLoading: true });
    try {
      const result = await api.discoverRooms();
      set({ discoverRooms: result.rooms, discoverLoading: false });
    } catch (err) {
      set({ discoverLoading: false });
    }
  },

  joinRoom: async (roomId: string) => {
    const { token, discoverRooms } = get();
    if (!token) return;
    set({ joiningRoomId: roomId });
    try {
      await api.joinRoom(roomId);
      const overview = await api.getOverview();
      set({ 
        overview, 
        joiningRoomId: null,
        discoverRooms: discoverRooms.filter((r) => r.room_id !== roomId)
      });
    } catch (err) {
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
    } catch (err) {
      set({ publicRoomsLoading: false });
    }
  },

  loadPublicRoomDetail: async (roomId: string) => {
    const cached = get().publicRoomDetails[roomId];
    if (cached) {
      return cached;
    }
    try {
      const result = await api.getPublicRoom(roomId);
      const room = result.rooms[0] || null;
      if (!room) {
        return null;
      }
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
    } catch (err) {
      set({ publicAgentsLoading: false });
    }
  },

  loadTopics: async (roomId: string) => {
    const { token, activeAgentId } = get();
    const resolvedAgentId = activeAgentId || getActiveAgentId();
    const canUseMemberView = Boolean(token && resolvedAgentId);

    if (token && resolvedAgentId && !activeAgentId) {
      set({ activeAgentId: resolvedAgentId });
    }

    await loadReadableRoomResource({
      canUseMemberView,
      loadMember: () => api.getTopics(token!, roomId),
      loadPublic: () => api.getPublicTopics(roomId),
      onSuccess: (result) => {
        set((state) => ({ topics: { ...state.topics, [roomId]: result.topics } }));
      },
      onMemberError: (error) => {
        console.error("[Store] Failed to load topics:", error);
      },
      onPublicError: (error) => {
        console.error("[Store] Failed to load public topics:", error);
        set((state) => ({ topics: { ...state.topics, [roomId]: [] } }));
      },
    });
  },

  loadWallet: async () => {
    const { token, activeAgentId } = get();
    if (!token) return;
    if (!hasReadyActiveAgent(token, activeAgentId)) {
      set({ wallet: null, walletError: null });
      return;
    }
    try {
      const wallet = await api.getWallet();
      set({ wallet, walletError: null });
    } catch (err: any) {
      set({ walletError: err.message || "Failed to load wallet" });
    }
  },

  loadWalletLedger: async (loadMore = false) => {
    const { token, activeAgentId, walletLedgerCursor, walletLedger } = get();
    if (!token) return;
    if (!hasReadyActiveAgent(token, activeAgentId)) {
      set({
        walletLedger: [],
        walletLedgerCursor: null,
        walletLedgerHasMore: false,
        walletLedgerError: null,
        walletLoading: false,
      });
      return;
    }
    set({ walletLoading: true });
    try {
      const cursor = loadMore ? walletLedgerCursor : undefined;
      const result = await api.getWalletLedger({ cursor: cursor ?? undefined, limit: 20 });
      if (loadMore) {
        set({ 
          walletLedger: [...walletLedger, ...result.entries], 
          walletLedgerHasMore: result.has_more, 
          walletLedgerCursor: result.next_cursor,
          walletLoading: false 
        });
      } else {
        set({ 
          walletLedger: result.entries, 
          walletLedgerHasMore: result.has_more, 
          walletLedgerCursor: result.next_cursor,
          walletLoading: false 
        });
      }
    } catch (err: any) {
      set({ walletLedgerError: err.message || "Failed to load ledger", walletLoading: false });
    }
  },

  loadWithdrawalRequests: async () => {
    const { token, activeAgentId } = get();
    if (!token) return;
    if (!hasReadyActiveAgent(token, activeAgentId)) {
      set({
        withdrawalRequests: [],
        withdrawalRequestsError: null,
        withdrawalRequestsLoaded: false,
        withdrawalRequestsLoading: false,
      });
      return;
    }
    set({ withdrawalRequestsLoading: true, withdrawalRequestsError: null });
    try {
      const result = await api.getWithdrawals();
      set({
        withdrawalRequests: result.withdrawals,
        withdrawalRequestsLoaded: true,
        withdrawalRequestsLoading: false,
      });
    } catch (err: any) {
      set({
        withdrawalRequestsError: err.message || "Failed to load withdrawals",
        withdrawalRequestsLoaded: true,
        withdrawalRequestsLoading: false,
      });
    }
  },

  switchActiveAgent: async (agentId: string) => {
    const { token } = get();
    setActiveAgentId(agentId);
    set({ activeAgentId: agentId, sessionMode: resolveSessionMode(token, agentId) });
    if (token) {
      set({ overviewRefreshing: true });
      try {
        const [overview, wallet, withdrawalsResult] = await Promise.all([
          api.getOverview(),
          api.getWallet().catch(() => null),
          api.getWithdrawals()
            .then((result) => ({ withdrawals: result.withdrawals, error: null }))
            .catch((err: any) => ({
              withdrawals: [],
              error: err.message || "Failed to load withdrawals",
            }))
        ]);
        set({
          overview,
          wallet,
          withdrawalRequests: withdrawalsResult.withdrawals,
          withdrawalRequestsError: withdrawalsResult.error,
          withdrawalRequestsLoaded: true,
          overviewRefreshing: false,
        });
        await get().loadContactRequests();
      } catch (err: any) {
        set({ error: err.message, overviewRefreshing: false });
      }
    }
  },

  refreshUserProfile: async () => {
    try {
      const user = await userApi.getMe({ force: true });
      const activeAgentId = resolveStoredActiveAgentId(user);
      setActiveAgentId(activeAgentId);
      set((state) => ({
        user,
        ownedAgents: user.agents,
        activeAgentId,
        sessionMode: resolveSessionMode(state.token, activeAgentId),
      }));
    } catch (err) {
      console.error("[Store] Failed to refresh user profile:", err);
    }
  },

  loadContactRequests: async () => {
    const { token, activeAgentId } = get();
    if (!hasReadyActiveAgent(token, activeAgentId)) {
      set({
        contactRequestsReceived: [],
        contactRequestsSent: [],
        contactRequestsLoading: false,
      });
      return;
    }
    set({ contactRequestsLoading: true });
    try {
      const [received, sent] = await Promise.all([
        api.getContactRequestsReceived(),
        api.getContactRequestsSent(),
      ]);
      const pendingSentTargets = sent.requests
        .filter((item) => item.state === "pending")
        .map((item) => item.to_agent_id);
      set({
        contactRequestsReceived: received.requests,
        contactRequestsSent: sent.requests,
        pendingFriendRequests: Array.from(new Set([...get().pendingFriendRequests, ...pendingSentTargets])),
        contactRequestsLoading: false,
      });
    } catch (err) {
      set({ contactRequestsLoading: false });
    }
  },

  sendContactRequest: async (toAgentId: string, message?: string) => {
    const { token } = get();
    if (!token) return;
    set({ sendingContactRequest: true });
    try {
      await api.createContactRequest({ to_agent_id: toAgentId, message });
      await get().loadContactRequests();
      set((state) => ({
        pendingFriendRequests: state.pendingFriendRequests.includes(toAgentId)
          ? state.pendingFriendRequests
          : [...state.pendingFriendRequests, toAgentId],
        sendingContactRequest: false,
      }));
    } catch (err) {
      set({ sendingContactRequest: false });
      throw err;
    }
  },

  respondContactRequest: async (requestId: number, action: 'accept' | 'reject') => {
    const { token } = get();
    if (!token) return;
    set({ processingContactRequestId: requestId });
    try {
      if (action === 'accept') {
        await api.acceptContactRequest(requestId);
      } else {
        await api.rejectContactRequest(requestId);
      }
      await Promise.all([get().refreshOverview(), get().loadContactRequests()]);
      set({ processingContactRequestId: null });
    } catch (err) {
      set({ processingContactRequestId: null });
      throw err;
    }
  },
    }),
    {
      name: "dashboard-storage",
      partialize: (state) => ({
        recentVisitedRooms: state.recentVisitedRooms,
        pendingFriendRequests: state.pendingFriendRequests,
      }),
    },
  ),
);
