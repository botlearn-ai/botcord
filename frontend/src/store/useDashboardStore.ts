import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { 
  DashboardOverview, DashboardMessage, AgentProfile, DashboardRoom, 
  DiscoverRoom, PublicRoom, TopicInfo, WalletSummary, WalletLedgerEntry,
  UserProfile, UserAgent, ContactRequestItem
} from "@/lib/types";
import { api, userApi, getActiveAgentId, setActiveAgentId } from "@/lib/api";

interface DashboardState {
  token: string | null;
  user: UserProfile | null;
  ownedAgents: UserAgent[];
  activeAgentId: string | null;
  overview: DashboardOverview | null;
  selectedRoomId: string | null;
  messages: Record<string, DashboardMessage[]>;
  messagesHasMore: Record<string, boolean>;
  loading: boolean;
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
  walletView: 'overview' | 'ledger';
  recentVisitedRooms: PublicRoom[];
  pendingFriendRequests: string[];
  contactRequestsReceived: ContactRequestItem[];
  contactRequestsSent: ContactRequestItem[];
  contactRequestsLoading: boolean;
  processingContactRequestId: number | null;
  sendingContactRequest: boolean;

  // Actions
  setToken: (token: string | null) => void;
  setUser: (user: UserProfile) => void;
  setActiveAgentId: (agentId: string | null) => void;
  setSelectedRoomId: (roomId: string | null) => void;
  setSidebarTab: (tab: DashboardState['sidebarTab']) => void;
  setExploreView: (view: DashboardState['exploreView']) => void;
  setContactsView: (view: DashboardState['contactsView']) => void;
  toggleRightPanel: () => void;
  setWalletView: (view: DashboardState['walletView']) => void;
  addRecentPublicRoom: (room: PublicRoom) => void;
  markFriendRequestPending: (agentId: string) => void;
  setError: (error: string | null) => void;
  setLoading: (loading: boolean) => void;
  logout: () => void;

  // Async Actions
  loadRoomMessages: (roomId: string) => Promise<void>;
  loadMoreMessages: (roomId: string) => Promise<void>;
  selectAgent: (agentId: string) => Promise<void>;
  searchAgents: (q: string) => Promise<void>;
  refreshOverview: () => Promise<void>;
  loadDiscoverRooms: () => Promise<void>;
  joinRoom: (roomId: string) => Promise<void>;
  loadPublicRooms: () => Promise<void>;
  loadPublicAgents: () => Promise<void>;
  loadTopics: (roomId: string) => Promise<void>;
  loadWallet: () => Promise<void>;
  loadWalletLedger: (loadMore?: boolean) => Promise<void>;
  switchActiveAgent: (agentId: string) => Promise<void>;
  refreshUserProfile: () => Promise<void>;
  initAuth: (token: string) => Promise<void>;
  loadContactRequests: () => Promise<void>;
  sendContactRequest: (toAgentId: string, message?: string) => Promise<void>;
  respondContactRequest: (requestId: number, action: 'accept' | 'reject') => Promise<void>;
}

const initialState = {
  token: null,
  user: null,
  ownedAgents: [],
  activeAgentId: null,
  overview: null,
  selectedRoomId: null,
  messages: {},
  messagesHasMore: {},
  topics: {},
  loading: false,
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

      setToken: (token) => {
        set({ token, error: null });
        if (token) {
          set({ sidebarTab: 'messages' });
        }
      },

      setUser: (user) => set({ user, ownedAgents: user.agents }),

      setActiveAgentId: (agentId) => set({ activeAgentId: agentId }),

      setSelectedRoomId: (roomId) => set({ selectedRoomId: roomId }),

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

      setError: (error) => set({ error, loading: false }),

      setLoading: (loading) => set({ loading }),

      logout: () => {
        setActiveAgentId(null);
        set({
          ...initialState,
          recentVisitedRooms: get().recentVisitedRooms,
          pendingFriendRequests: get().pendingFriendRequests,
          publicRooms: get().publicRooms,
          publicAgents: get().publicAgents,
          sidebarTab: "messages",
        });
      },

  // Async Actions
      initAuth: async (token: string) => {
    set({ loading: true, token });
    
    try {
      const user = await userApi.getMe();
      set({ user, ownedAgents: user.agents });

      const savedAgentId = getActiveAgentId();
      const hasAgents = user.agents.length > 0;
      let activeId: string | null = null;

      if (hasAgents) {
        if (savedAgentId && user.agents.some((a) => a.agent_id === savedAgentId)) {
          activeId = savedAgentId;
        } else {
          const defaultAgent = user.agents.find((a) => a.is_default) || user.agents[0];
          activeId = defaultAgent.agent_id;
        }
        setActiveAgentId(activeId);
        set({ activeAgentId: activeId });
      }

      if (activeId) {
        const [overview, wallet] = await Promise.all([
          api.getOverview(),
          api.getWallet().catch(() => null)
        ]);
        set({ overview, wallet, loading: false });
        await get().loadContactRequests();
      } else {
        set({ loading: false });
      }
    } catch (err: any) {
      console.warn("[Store] User profile unavailable, falling back to direct mode:", err.message);
      try {
        const [overview, wallet] = await Promise.all([
          api.getOverview(),
          api.getWallet().catch(() => null)
        ]);
        set({ overview, wallet, loading: false });
        await get().loadContactRequests();
      } catch (innerErr: any) {
        set({ error: innerErr.message || "Failed to load overview", loading: false });
      }
    }
  },

  loadRoomMessages: async (roomId: string) => {
    const { token } = get();
    try {
      let result;
      if (token) {
        try {
          result = await api.getRoomMessages(roomId, { limit: 50 });
        } catch (err: any) {
          // Logged-in but not joined: fallback to public room history for read-only browsing.
          if (err?.status === 403) {
            result = await api.getPublicRoomMessages(roomId, { limit: 50 });
          } else {
            throw err;
          }
        }
      } else {
        result = await api.getPublicRoomMessages(roomId, { limit: 50 });
      }
      
      set((state) => ({
        messages: { ...state.messages, [roomId]: result.messages.reverse() },
        messagesHasMore: { ...state.messagesHasMore, [roomId]: result.has_more },
      }));
    } catch (err) {
      console.error("[Store] Failed to load messages:", err);
    }
  },

  loadMoreMessages: async (roomId: string) => {
    const { token, messages } = get();
    const existing = messages[roomId];
    if (!existing || existing.length === 0) return;
    
    const oldest = existing[0];
    try {
      let result;
      if (token) {
        try {
          result = await api.getRoomMessages(roomId, { before: oldest.hub_msg_id, limit: 50 });
        } catch (err: any) {
          if (err?.status === 403) {
            result = await api.getPublicRoomMessages(roomId, { before: oldest.hub_msg_id, limit: 50 });
          } else {
            throw err;
          }
        }
      } else {
        result = await api.getPublicRoomMessages(roomId, { before: oldest.hub_msg_id, limit: 50 });
      }
      
      set((state) => ({
        messages: { ...state.messages, [roomId]: [...result.messages.reverse(), ...existing] },
        messagesHasMore: { ...state.messagesHasMore, [roomId]: result.has_more },
      }));
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
    const { token, selectedRoomId } = get();
    if (!token) {
      const store = get();
      await Promise.all([store.loadPublicRooms(), store.loadPublicAgents()]);
      return;
    }
    
    set({ loading: true });
    try {
      const overview = await api.getOverview();
      set({ overview, loading: false });
      await get().loadContactRequests();
      if (selectedRoomId) {
        get().loadRoomMessages(selectedRoomId);
      }
    } catch (err: any) {
      set({ error: err.message || "Failed to refresh", loading: false });
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
      set({ publicRooms: result.rooms, publicRoomsLoading: false });
    } catch (err) {
      set({ publicRoomsLoading: false });
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
    if (!token) return;
    const resolvedAgentId = activeAgentId || getActiveAgentId();
    if (!resolvedAgentId) {
      set((state) => ({ topics: { ...state.topics, [roomId]: [] } }));
      return;
    }
    if (!activeAgentId) {
      set({ activeAgentId: resolvedAgentId });
    }
    try {
      const result = await api.getTopics(token, roomId);
      set((state) => ({ topics: { ...state.topics, [roomId]: result.topics } }));
    } catch (err) {
      console.error("[Store] Failed to load topics:", err);
    }
  },

  loadWallet: async () => {
    const { token } = get();
    if (!token) return;
    try {
      const wallet = await api.getWallet();
      set({ wallet, walletError: null });
    } catch (err: any) {
      set({ walletError: err.message || "Failed to load wallet" });
    }
  },

  loadWalletLedger: async (loadMore = false) => {
    const { token, walletLedgerCursor, walletLedger } = get();
    if (!token) return;
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

  switchActiveAgent: async (agentId: string) => {
    const { token } = get();
    setActiveAgentId(agentId);
    set({ activeAgentId: agentId });
    if (token) {
      set({ loading: true });
      try {
        const [overview, wallet] = await Promise.all([
          api.getOverview(),
          api.getWallet().catch(() => null)
        ]);
        set({ overview, wallet, loading: false });
        await get().loadContactRequests();
      } catch (err: any) {
        set({ error: err.message, loading: false });
      }
    }
  },

  refreshUserProfile: async () => {
    try {
      const user = await userApi.getMe();
      set({ user, ownedAgents: user.agents });
    } catch (err) {
      console.error("[Store] Failed to refresh user profile:", err);
    }
  },

  loadContactRequests: async () => {
    const { token } = get();
    if (!token) {
      set({ contactRequestsReceived: [], contactRequestsSent: [] });
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
