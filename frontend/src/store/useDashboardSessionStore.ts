/**
 * [INPUT]: 依赖 zustand 保存 dashboard 会话状态，依赖 @/lib/api 与 active-agent 工具完成用户身份解析
 * [OUTPUT]: 对外提供 useDashboardSessionStore 会话域状态仓库与鉴权相关异步动作
 * [POS]: frontend dashboard 的 session 主域，负责登录态、用户资料、活跃 agent 与准入模式
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

import { create } from "zustand";
import type { HumanInfo, HumanRoomSummary, UserProfile, UserAgent } from "@/lib/types";
import {
  humansApi,
  userApi,
  getActiveAgentId,
  setActiveAgentId as persistActiveAgentId,
  setStoredActiveIdentity,
} from "@/lib/api";
import { usePresenceStore } from "./usePresenceStore";

// Sync owned agents' daemon-derived ws_online (from /api/users/me) into the
// presence store, so MessageBubble's PresenceDot reflects the same state the
// Sidebar shows. Realtime presence events will still override via setOnline's
// timestamp ordering.
function syncOwnedAgentsPresence(agents: UserAgent[]): void {
  const setOnline = usePresenceStore.getState().setOnline;
  const now = Date.now();
  for (const agent of agents) {
    setOnline(agent.agent_id, Boolean(agent.ws_online), now);
  }
}

export type DashboardSessionMode = "guest" | "authed-no-agent" | "authed-ready";

export type ActiveIdentity =
  | { type: "human"; id: string }
  | { type: "agent"; id: string };

interface DashboardSessionState {
  authResolved: boolean;
  authBootstrapping: boolean;
  sessionMode: DashboardSessionMode;
  token: string | null;
  user: UserProfile | null;
  /** Current Human identity (hu_*). Populated after /api/humans/me returns. */
  human: HumanInfo | null;
  /** Rooms owned-or-joined by the current Human (from /api/humans/me/rooms). */
  humanRooms: HumanRoomSummary[];
  ownedAgents: UserAgent[];
  activeAgentId: string | null;
  /** Dashboard always acts as the logged-in Human. */
  viewMode: "human" | "agent";
  /**
   * Dashboard actor identity. Bot selection is tracked separately in
   * ``activeAgentId`` and must not switch this to an Agent.
   */
  activeIdentity: ActiveIdentity | null;

  setHuman: (human: HumanInfo) => void;
  setAuthResolved: (resolved: boolean) => void;
  setToken: (token: string | null) => void;
  setUser: (user: UserProfile) => void;
  setActiveAgentId: (agentId: string | null) => void;
  setViewMode: (mode: "human" | "agent") => void;
  setActiveIdentity: (identity: ActiveIdentity | null) => void;
  resetSessionState: () => void;
  initAuth: (token: string) => Promise<void>;
  refreshUserProfile: () => Promise<void>;
  refreshHumanRooms: () => Promise<void>;
  removeAgent: (agentId: string) => void;
  switchActiveAgent: (agentId: string) => Promise<void>;
  logout: () => void;
}

const initialSessionState = {
  authResolved: false,
  authBootstrapping: false,
  sessionMode: "guest" as const,
  token: null,
  user: null,
  human: null,
  humanRooms: [] as HumanRoomSummary[],
  ownedAgents: [],
  activeAgentId: null,
  viewMode: "human" as const,
  activeIdentity: null as ActiveIdentity | null,
};

function deriveIdentityFromHuman(human: HumanInfo | null): ActiveIdentity | null {
  return human?.human_id ? { type: "human", id: human.human_id } : null;
}

let authInitRequestId = 0;

function resolveStoredActiveAgentId(user: UserProfile): string | null {
  const savedAgentId = getActiveAgentId();
  if (savedAgentId && user.agents.some((agent) => agent.agent_id === savedAgentId)) {
    return savedAgentId;
  }
  const defaultAgent = user.agents.find((agent) => agent.is_default) || user.agents[0];
  return defaultAgent?.agent_id ?? null;
}

function resolveSessionMode(token: string | null, activeAgentId: string | null): DashboardSessionMode {
  if (!token) return "guest";
  return activeAgentId ? "authed-ready" : "authed-no-agent";
}

export const useDashboardSessionStore = create<DashboardSessionState>()((set, get) => ({
  ...initialSessionState,

  setAuthResolved: (authResolved) => set({ authResolved }),

  setToken: (token) => {
    if (!token) {
      authInitRequestId += 1;
      persistActiveAgentId(null);
      setStoredActiveIdentity(null);
      set({
        ...initialSessionState,
        authResolved: true,
        authBootstrapping: false,
      });
      return;
    }

    const activeAgentId = get().activeAgentId || getActiveAgentId();
    const activeIdentity = deriveIdentityFromHuman(get().human);
    setStoredActiveIdentity(activeIdentity);
    set({
      authResolved: true,
      authBootstrapping: false,
      token,
      activeAgentId,
      activeIdentity,
      viewMode: "human",
      sessionMode: resolveSessionMode(token, activeAgentId),
    });
  },

  setUser: (user) => {
    syncOwnedAgentsPresence(user.agents);
    set((state) => ({
      user,
      ownedAgents: user.agents,
      sessionMode: resolveSessionMode(state.token, state.activeAgentId),
    }));
  },

  setHuman: (human) =>
    set((state) => {
      const activeIdentity: ActiveIdentity = { type: "human", id: human.human_id };
      setStoredActiveIdentity(activeIdentity);
      return {
        human,
        user: state.user ? { ...state.user, display_name: human.display_name, avatar_url: human.avatar_url } : state.user,
        activeIdentity,
        viewMode: "human",
      };
    }),

  setActiveAgentId: (agentId) =>
    set((state) => {
      persistActiveAgentId(agentId);
      return {
        activeAgentId: agentId,
        activeIdentity: state.activeIdentity,
        viewMode: "human",
        sessionMode: resolveSessionMode(state.token, agentId),
      };
    }),

  setViewMode: (mode) =>
    set((state) => {
      const humanId = state.human?.human_id ?? null;
      if (!humanId) {
        console.warn(
          `[SessionStore] setViewMode('${mode}') ignored — no human.human_id loaded yet`,
        );
        return {};
      }
      const nextIdentity: ActiveIdentity = { type: "human", id: humanId };
      setStoredActiveIdentity(nextIdentity);
      return { viewMode: "human", activeIdentity: nextIdentity };
    }),

  setActiveIdentity: (identity) => {
    const nextIdentity = identity?.type === "human" ? identity : deriveIdentityFromHuman(get().human);
    setStoredActiveIdentity(nextIdentity);
    set((state) => ({
      activeIdentity: nextIdentity,
      activeAgentId: state.activeAgentId,
      viewMode: "human",
      sessionMode: resolveSessionMode(state.token, state.activeAgentId),
    }));
  },

  resetSessionState: () => {
    authInitRequestId += 1;
    persistActiveAgentId(null);
    setStoredActiveIdentity(null);
    set({ ...initialSessionState });
  },

  initAuth: async (token: string) => {
    const requestId = ++authInitRequestId;
    const current = get();
    const shouldShowBootstrap = !current.authResolved;

    set({
      authResolved: shouldShowBootstrap ? false : current.authResolved,
      authBootstrapping: shouldShowBootstrap,
      token,
    });

    try {
      const [user, human, humanRoomsRes] = await Promise.all([
        userApi.getMe(),
        // Idempotent — the first call mints the Human identity for brand-new
        // users; subsequent calls return the existing record. Failure here is
        // non-fatal: Human-first features degrade but Agent flows keep working.
        humansApi.createOrGet().catch((err) => {
          console.warn("[SessionStore] Failed to load Human identity:", err);
          return null;
        }),
        humansApi.listRooms().catch((err) => {
          console.warn("[SessionStore] Failed to load Human rooms:", err);
          return { rooms: [] as HumanRoomSummary[] };
        }),
      ]);
      if (requestId !== authInitRequestId) {
        return;
      }
      const activeId = resolveStoredActiveAgentId(user);
      persistActiveAgentId(activeId);
      const activeIdentity = deriveIdentityFromHuman(human);
      setStoredActiveIdentity(activeIdentity);
      syncOwnedAgentsPresence(user.agents);
      set({
        authResolved: true,
        authBootstrapping: false,
        token,
        user,
        human,
        humanRooms: humanRoomsRes.rooms,
        ownedAgents: user.agents,
        activeAgentId: activeId,
        activeIdentity,
        viewMode: "human",
        sessionMode: resolveSessionMode(token, activeId),
      });
    } catch (err: any) {
      if (requestId !== authInitRequestId) {
        return;
      }
      if (err?.status === 401 || err?.status === 403) {
        persistActiveAgentId(null);
        setStoredActiveIdentity(null);
        set({
          ...initialSessionState,
          authResolved: true,
          authBootstrapping: false,
        });
        return;
      }
      persistActiveAgentId(null);
      setStoredActiveIdentity(null);
      set({
        authResolved: true,
        authBootstrapping: false,
        token,
        user: null,
        ownedAgents: [],
        activeAgentId: null,
        activeIdentity: null,
        sessionMode: "authed-no-agent",
      });
    }
  },

  refreshHumanRooms: async () => {
    try {
      const res = await humansApi.listRooms();
      set({ humanRooms: res.rooms });
    } catch (err) {
      console.warn("[SessionStore] refreshHumanRooms failed:", err);
    }
  },

  refreshUserProfile: async () => {
    try {
      const user = await userApi.getMe({ force: true });
      const activeAgentId = resolveStoredActiveAgentId(user);
      persistActiveAgentId(activeAgentId);
      syncOwnedAgentsPresence(user.agents);
      set((state) => {
        const nextIdentity = deriveIdentityFromHuman(state.human);
        setStoredActiveIdentity(nextIdentity);
        return {
          user,
          ownedAgents: user.agents,
          activeAgentId,
          activeIdentity: nextIdentity,
          viewMode: "human",
          sessionMode: resolveSessionMode(state.token, activeAgentId),
        };
      });
    } catch (err) {
      console.error("[SessionStore] Failed to refresh user profile:", err);
    }
  },

  removeAgent: (agentId: string) => {
    const { ownedAgents, activeAgentId, activeIdentity, token } = get();
    const remaining = ownedAgents.filter((a) => a.agent_id !== agentId);
    const newActiveId = agentId === activeAgentId
      ? (remaining.find((a) => a.is_default) || remaining[0])?.agent_id ?? null
      : activeAgentId;
    persistActiveAgentId(newActiveId);
    set({
      ownedAgents: remaining,
      activeAgentId: newActiveId,
      activeIdentity,
      viewMode: "human",
      sessionMode: resolveSessionMode(token, newActiveId),
    });
  },

  switchActiveAgent: async (agentId: string) => {
    persistActiveAgentId(agentId);
    set((state) => ({
      activeAgentId: agentId,
      activeIdentity: state.activeIdentity,
      viewMode: "human",
      sessionMode: resolveSessionMode(state.token, agentId),
    }));
  },

  logout: () => {
    authInitRequestId += 1;
    persistActiveAgentId(null);
    setStoredActiveIdentity(null);
    usePresenceStore.getState().reset();
    set({
      ...initialSessionState,
      authResolved: true,
    });
  },
}));
