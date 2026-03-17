import { createContext, useContext, useReducer, useEffect, useCallback, useState } from "react";
import type { DashboardOverview, DashboardMessage, AgentProfile, DashboardRoom, DiscoverRoom, PublicRoom, TopicInfo } from "../../lib/types";
import { api } from "../../lib/api";
import LoginPanel from "./LoginPanel";
import Sidebar from "./Sidebar";
import ChatPane from "./ChatPane";
import AgentBrowser from "./AgentBrowser";

// --- State ---

interface DashboardState {
  token: string | null;
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
  sidebarTab: "rooms" | "contacts" | "discover" | "agents";
  discoverRooms: DiscoverRoom[];
  discoverLoading: boolean;
  joiningRoomId: string | null;
  // Topics per room
  topics: Record<string, TopicInfo[]>;
  // Guest mode state
  publicRooms: PublicRoom[];
  publicRoomsLoading: boolean;
  publicAgents: AgentProfile[];
  publicAgentsLoading: boolean;
}

type Action =
  | { type: "SET_TOKEN"; token: string | null }
  | { type: "SET_OVERVIEW"; overview: DashboardOverview }
  | { type: "SET_LOADING"; loading: boolean }
  | { type: "SET_ERROR"; error: string | null }
  | { type: "SELECT_ROOM"; roomId: string | null }
  | { type: "SET_MESSAGES"; roomId: string; messages: DashboardMessage[]; hasMore: boolean }
  | { type: "PREPEND_MESSAGES"; roomId: string; messages: DashboardMessage[]; hasMore: boolean }
  | { type: "APPEND_MESSAGE"; roomId: string; message: DashboardMessage }
  | { type: "TOGGLE_RIGHT_PANEL" }
  | { type: "SET_SELECTED_AGENT"; agentId: string | null; profile?: AgentProfile | null; conversations?: DashboardRoom[] | null }
  | { type: "SET_SEARCH_RESULTS"; results: AgentProfile[] | null }
  | { type: "SET_SIDEBAR_TAB"; tab: "rooms" | "contacts" | "discover" | "agents" }
  | { type: "SET_DISCOVER_ROOMS"; rooms: DiscoverRoom[] }
  | { type: "SET_DISCOVER_LOADING"; loading: boolean }
  | { type: "SET_JOINING_ROOM"; roomId: string | null }
  | { type: "SET_TOPICS"; roomId: string; topics: TopicInfo[] }
  | { type: "LOGOUT" }
  | { type: "REFRESH" }
  | { type: "SET_PUBLIC_ROOMS"; rooms: PublicRoom[] }
  | { type: "SET_PUBLIC_ROOMS_LOADING"; loading: boolean }
  | { type: "SET_PUBLIC_AGENTS"; agents: AgentProfile[] }
  | { type: "SET_PUBLIC_AGENTS_LOADING"; loading: boolean };

function reducer(state: DashboardState, action: Action): DashboardState {
  switch (action.type) {
    case "SET_TOKEN":
      return { ...state, token: action.token, error: null };
    case "SET_OVERVIEW":
      return { ...state, overview: action.overview, loading: false };
    case "SET_LOADING":
      return { ...state, loading: action.loading };
    case "SET_ERROR":
      return { ...state, error: action.error, loading: false };
    case "SELECT_ROOM":
      return { ...state, selectedRoomId: action.roomId };
    case "SET_MESSAGES":
      return {
        ...state,
        messages: { ...state.messages, [action.roomId]: action.messages },
        messagesHasMore: { ...state.messagesHasMore, [action.roomId]: action.hasMore },
      };
    case "PREPEND_MESSAGES": {
      const existing = state.messages[action.roomId] || [];
      return {
        ...state,
        messages: { ...state.messages, [action.roomId]: [...action.messages, ...existing] },
        messagesHasMore: { ...state.messagesHasMore, [action.roomId]: action.hasMore },
      };
    }
    case "APPEND_MESSAGE": {
      const existing = state.messages[action.roomId] || [];
      // Deduplicate by hub_msg_id
      if (existing.some((m) => m.hub_msg_id === action.message.hub_msg_id)) return state;
      return {
        ...state,
        messages: { ...state.messages, [action.roomId]: [...existing, action.message] },
      };
    }
    case "TOGGLE_RIGHT_PANEL":
      return { ...state, rightPanelOpen: !state.rightPanelOpen };
    case "SET_SELECTED_AGENT":
      return {
        ...state,
        selectedAgentId: action.agentId,
        selectedAgentProfile: action.profile ?? null,
        selectedAgentConversations: action.conversations ?? null,
        rightPanelOpen: action.agentId !== null,
      };
    case "SET_SEARCH_RESULTS":
      return { ...state, searchResults: action.results };
    case "SET_SIDEBAR_TAB":
      return { ...state, sidebarTab: action.tab };
    case "SET_DISCOVER_ROOMS":
      return { ...state, discoverRooms: action.rooms, discoverLoading: false };
    case "SET_DISCOVER_LOADING":
      return { ...state, discoverLoading: action.loading };
    case "SET_JOINING_ROOM":
      return { ...state, joiningRoomId: action.roomId };
    case "SET_TOPICS":
      return { ...state, topics: { ...state.topics, [action.roomId]: action.topics } };
    case "REFRESH":
      return { ...state, loading: true };
    case "LOGOUT":
      localStorage.removeItem("botcord_token");
      return { ...initialState, publicRooms: state.publicRooms, publicAgents: state.publicAgents, sidebarTab: "discover" };
    case "SET_PUBLIC_ROOMS":
      return { ...state, publicRooms: action.rooms, publicRoomsLoading: false };
    case "SET_PUBLIC_ROOMS_LOADING":
      return { ...state, publicRoomsLoading: action.loading };
    case "SET_PUBLIC_AGENTS":
      return { ...state, publicAgents: action.agents, publicAgentsLoading: false };
    case "SET_PUBLIC_AGENTS_LOADING":
      return { ...state, publicAgentsLoading: action.loading };
    default:
      return state;
  }
}

const initialState: DashboardState = {
  token: null,
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
  sidebarTab: "discover",
  discoverRooms: [],
  discoverLoading: false,
  joiningRoomId: null,
  publicRooms: [],
  publicRoomsLoading: false,
  publicAgents: [],
  publicAgentsLoading: false,
};

// --- Context ---

interface DashboardContextValue {
  state: DashboardState;
  dispatch: React.Dispatch<Action>;
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
  isGuest: boolean;
  showLoginModal: () => void;
}

const DashboardContext = createContext<DashboardContextValue | null>(null);

export function useDashboard() {
  const ctx = useContext(DashboardContext);
  if (!ctx) throw new Error("useDashboard must be used within DashboardApp");
  return ctx;
}

// --- Root Component ---

export default function DashboardApp() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const [loginModalOpen, setLoginModalOpen] = useState(false);

  const isGuest = !state.token;

  // Restore token from localStorage on mount
  useEffect(() => {
    const saved = localStorage.getItem("botcord_token");
    if (saved) {
      dispatch({ type: "SET_TOKEN", token: saved });
      dispatch({ type: "SET_SIDEBAR_TAB", tab: "rooms" });
    }
  }, []);

  // Guest mode: load public data on mount
  useEffect(() => {
    if (!state.token) {
      loadPublicRooms();
      loadPublicAgents();
    }
  }, [state.token]);

  // Load overview when token is set (auth mode)
  useEffect(() => {
    if (!state.token) return;
    dispatch({ type: "SET_LOADING", loading: true });
    console.log("[Dashboard] Loading overview with token:", state.token.substring(0, 20) + "...");
    api
      .getOverview(state.token)
      .then((overview) => {
        console.log("[Dashboard] Overview loaded:", overview);
        dispatch({ type: "SET_OVERVIEW", overview });
      })
      .catch((err) => {
        console.error("[Dashboard] Overview failed:", err, "status:", err.status);
        dispatch({ type: "SET_ERROR", error: err.message || "Failed to load overview" });
        if (err.status === 401) {
          console.warn("[Dashboard] 401 → logging out");
          dispatch({ type: "LOGOUT" });
        }
      });
  }, [state.token]);

  const loadRoomMessages = useCallback(
    async (roomId: string) => {
      console.log("[Dashboard] Loading messages for room:", roomId);
      try {
        let result;
        if (state.token) {
          result = await api.getRoomMessages(state.token, roomId, { limit: 50 });
        } else {
          // Guest mode: use public API
          result = await api.getPublicRoomMessages(roomId, { limit: 50 });
        }
        console.log("[Dashboard] Got", result.messages.length, "messages for room:", roomId);
        dispatch({
          type: "SET_MESSAGES",
          roomId,
          messages: result.messages.reverse(),
          hasMore: result.has_more,
        });
      } catch (err) {
        console.error("[Dashboard] Failed to load messages for room:", roomId, err);
      }
    },
    [state.token],
  );

  const loadMoreMessages = useCallback(
    async (roomId: string) => {
      const existing = state.messages[roomId];
      if (!existing || existing.length === 0) return;
      const oldest = existing[0];
      let result;
      if (state.token) {
        result = await api.getRoomMessages(state.token, roomId, {
          before: oldest.hub_msg_id,
          limit: 50,
        });
      } else {
        result = await api.getPublicRoomMessages(roomId, {
          before: oldest.hub_msg_id,
          limit: 50,
        });
      }
      dispatch({
        type: "PREPEND_MESSAGES",
        roomId,
        messages: result.messages.reverse(),
        hasMore: result.has_more,
      });
    },
    [state.token, state.messages],
  );

  const selectAgent = useCallback(
    async (agentId: string) => {
      console.log("[Dashboard] Selecting agent:", agentId);
      try {
        if (state.token) {
          const [profile, convos] = await Promise.all([
            api.getAgentProfile(state.token, agentId),
            api.getConversations(state.token, agentId),
          ]);
          console.log("[Dashboard] Agent profile:", profile, "conversations:", convos);
          dispatch({
            type: "SET_SELECTED_AGENT",
            agentId,
            profile,
            conversations: convos.conversations,
          });
        } else {
          // Guest mode: public profile only, no shared conversations
          const profile = await api.getPublicAgentProfile(agentId);
          dispatch({
            type: "SET_SELECTED_AGENT",
            agentId,
            profile,
            conversations: null,
          });
        }
      } catch (err) {
        console.error("[Dashboard] Failed to select agent:", agentId, err);
      }
    },
    [state.token],
  );

  const searchAgents = useCallback(
    async (q: string) => {
      if (!q.trim()) {
        dispatch({ type: "SET_SEARCH_RESULTS", results: null });
        return;
      }
      console.log("[Dashboard] Searching agents:", q);
      try {
        if (state.token) {
          const result = await api.searchAgents(state.token, q);
          console.log("[Dashboard] Search results:", result.agents);
          dispatch({ type: "SET_SEARCH_RESULTS", results: result.agents });
        } else {
          const result = await api.getPublicAgents({ q });
          dispatch({ type: "SET_SEARCH_RESULTS", results: result.agents });
        }
      } catch (err) {
        console.error("[Dashboard] Search failed:", q, err);
      }
    },
    [state.token],
  );

  const refreshOverview = useCallback(async () => {
    if (!state.token) {
      // Guest mode: refresh public data
      loadPublicRooms();
      loadPublicAgents();
      return;
    }
    dispatch({ type: "REFRESH" });
    try {
      const overview = await api.getOverview(state.token);
      dispatch({ type: "SET_OVERVIEW", overview });
      // Reload messages for the currently selected room
      if (state.selectedRoomId) {
        const result = await api.getRoomMessages(state.token, state.selectedRoomId, { limit: 50 });
        dispatch({
          type: "SET_MESSAGES",
          roomId: state.selectedRoomId,
          messages: result.messages.reverse(),
          hasMore: result.has_more,
        });
      }
    } catch (err: any) {
      dispatch({ type: "SET_ERROR", error: err.message || "Failed to refresh" });
    }
  }, [state.token, state.selectedRoomId]);

  const loadDiscoverRooms = useCallback(async () => {
    if (!state.token) return;
    dispatch({ type: "SET_DISCOVER_LOADING", loading: true });
    try {
      const result = await api.discoverRooms(state.token);
      dispatch({ type: "SET_DISCOVER_ROOMS", rooms: result.rooms });
    } catch (err: any) {
      console.error("[Dashboard] Failed to load discover rooms:", err);
      dispatch({ type: "SET_DISCOVER_LOADING", loading: false });
    }
  }, [state.token]);

  const joinRoom = useCallback(async (roomId: string) => {
    if (!state.token) return;
    dispatch({ type: "SET_JOINING_ROOM", roomId });
    try {
      await api.joinRoom(state.token, roomId);
      // Refresh overview to get updated room list, and reload discover list
      const overview = await api.getOverview(state.token);
      dispatch({ type: "SET_OVERVIEW", overview });
      dispatch({ type: "SET_JOINING_ROOM", roomId: null });
      // Remove the joined room from discover list
      dispatch({
        type: "SET_DISCOVER_ROOMS",
        rooms: state.discoverRooms.filter((r) => r.room_id !== roomId),
      });
    } catch (err: any) {
      console.error("[Dashboard] Failed to join room:", roomId, err);
      dispatch({ type: "SET_JOINING_ROOM", roomId: null });
    }
  }, [state.token, state.discoverRooms]);

  const loadPublicRooms = useCallback(async () => {
    dispatch({ type: "SET_PUBLIC_ROOMS_LOADING", loading: true });
    try {
      const result = await api.getPublicRooms({ limit: 50 });
      dispatch({ type: "SET_PUBLIC_ROOMS", rooms: result.rooms });
    } catch (err) {
      console.error("[Dashboard] Failed to load public rooms:", err);
      dispatch({ type: "SET_PUBLIC_ROOMS_LOADING", loading: false });
    }
  }, []);

  const loadTopics = useCallback(async (roomId: string) => {
    if (!state.token) return;
    try {
      const result = await api.getTopics(state.token, roomId);
      dispatch({ type: "SET_TOPICS", roomId, topics: result.topics });
    } catch (err) {
      console.error("[Dashboard] Failed to load topics for room:", roomId, err);
    }
  }, [state.token]);

  const loadPublicAgents = useCallback(async () => {
    dispatch({ type: "SET_PUBLIC_AGENTS_LOADING", loading: true });
    try {
      const result = await api.getPublicAgents({ limit: 50 });
      dispatch({ type: "SET_PUBLIC_AGENTS", agents: result.agents });
    } catch (err) {
      console.error("[Dashboard] Failed to load public agents:", err);
      dispatch({ type: "SET_PUBLIC_AGENTS_LOADING", loading: false });
    }
  }, []);

  const handleLogin = useCallback((token: string) => {
    localStorage.setItem("botcord_token", token);
    dispatch({ type: "SET_TOKEN", token });
    dispatch({ type: "SET_SIDEBAR_TAB", tab: "rooms" });
    setLoginModalOpen(false);
  }, []);

  const showLoginModal = useCallback(() => {
    setLoginModalOpen(true);
  }, []);

  const ctxValue: DashboardContextValue = {
    state,
    dispatch,
    loadRoomMessages,
    loadMoreMessages,
    selectAgent,
    searchAgents,
    refreshOverview,
    loadDiscoverRooms,
    joinRoom,
    loadPublicRooms,
    loadPublicAgents,
    loadTopics,
    isGuest,
    showLoginModal,
  };

  // Auth mode: loading state
  if (state.token && state.loading && !state.overview) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="text-neon-cyan animate-pulse text-lg">Loading...</div>
      </div>
    );
  }

  // Auth mode: error state
  if (state.token && state.error && !state.overview) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-4">
        <div className="text-red-400">{state.error}</div>
        <button
          onClick={() => dispatch({ type: "LOGOUT" })}
          className="rounded border border-glass-border px-4 py-2 text-text-secondary hover:text-text-primary"
        >
          Back to Login
        </button>
      </div>
    );
  }

  return (
    <DashboardContext.Provider value={ctxValue}>
      <div className="flex h-screen overflow-hidden">
        <Sidebar />
        <ChatPane />
        {state.rightPanelOpen && <AgentBrowser />}
      </div>
      {/* Login Modal */}
      {loginModalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
          onClick={() => setLoginModalOpen(false)}
        >
          <div onClick={(e) => e.stopPropagation()}>
            <LoginPanel onLogin={handleLogin} onClose={() => setLoginModalOpen(false)} />
          </div>
        </div>
      )}
    </DashboardContext.Provider>
  );
}
