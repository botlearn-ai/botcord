/**
 * [INPUT]: 依赖 zustand 保存 dashboard 会话状态，依赖 @/lib/api 与 active-agent 工具完成用户身份解析
 * [OUTPUT]: 对外提供 useDashboardSessionStore 会话域状态仓库与鉴权相关异步动作
 * [POS]: frontend dashboard 的 session 主域，负责登录态、用户资料、活跃 agent 与准入模式
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

import { create } from "zustand";
import type { HumanInfo, HumanRoomSummary, UserProfile, UserAgent } from "@/lib/types";
import { humansApi, userApi, getActiveAgentId, setActiveAgentId } from "@/lib/api";

export type DashboardSessionMode = "guest" | "authed-no-agent" | "authed-ready";

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

  setAuthResolved: (resolved: boolean) => void;
  setToken: (token: string | null) => void;
  setUser: (user: UserProfile) => void;
  setActiveAgentId: (agentId: string | null) => void;
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
};

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
      setActiveAgentId(null);
      set({
        ...initialSessionState,
        authResolved: true,
        authBootstrapping: false,
      });
      return;
    }

    const activeAgentId = get().activeAgentId || getActiveAgentId();
    set({
      authResolved: true,
      authBootstrapping: false,
      token,
      activeAgentId,
      sessionMode: resolveSessionMode(token, activeAgentId),
    });
  },

  setUser: (user) =>
    set((state) => ({
      user,
      ownedAgents: user.agents,
      sessionMode: resolveSessionMode(state.token, state.activeAgentId),
    })),

  setActiveAgentId: (agentId) =>
    set((state) => ({
      activeAgentId: agentId,
      sessionMode: resolveSessionMode(state.token, agentId),
    })),

  resetSessionState: () => {
    authInitRequestId += 1;
    setActiveAgentId(null);
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
      setActiveAgentId(activeId);
      set({
        authResolved: true,
        authBootstrapping: false,
        token,
        user,
        human,
        humanRooms: humanRoomsRes.rooms,
        ownedAgents: user.agents,
        activeAgentId: activeId,
        sessionMode: resolveSessionMode(token, activeId),
      });
    } catch (err: any) {
      if (requestId !== authInitRequestId) {
        return;
      }
      if (err?.status === 401 || err?.status === 403) {
        setActiveAgentId(null);
        set({
          ...initialSessionState,
          authResolved: true,
          authBootstrapping: false,
        });
        return;
      }
      setActiveAgentId(null);
      set({
        authResolved: true,
        authBootstrapping: false,
        token,
        user: null,
        ownedAgents: [],
        activeAgentId: null,
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
      setActiveAgentId(activeAgentId);
      set((state) => ({
        user,
        ownedAgents: user.agents,
        activeAgentId,
        sessionMode: resolveSessionMode(state.token, activeAgentId),
      }));
    } catch (err) {
      console.error("[SessionStore] Failed to refresh user profile:", err);
    }
  },

  removeAgent: (agentId: string) => {
    const { ownedAgents, activeAgentId, token } = get();
    const remaining = ownedAgents.filter((a) => a.agent_id !== agentId);
    const newActiveId = agentId === activeAgentId
      ? (remaining.find((a) => a.is_default) || remaining[0])?.agent_id ?? null
      : activeAgentId;
    setActiveAgentId(newActiveId);
    set({
      ownedAgents: remaining,
      activeAgentId: newActiveId,
      sessionMode: resolveSessionMode(token, newActiveId),
    });
  },

  switchActiveAgent: async (agentId: string) => {
    setActiveAgentId(agentId);
    set({ activeAgentId: agentId });
  },

  logout: () => {
    authInitRequestId += 1;
    setActiveAgentId(null);
    set({
      ...initialSessionState,
      authResolved: true,
    });
  },
}));

