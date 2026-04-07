/**
 * [INPUT]: 依赖 zustand 保存联系人域状态，依赖 @/lib/api 发起联系人请求，依赖 chat store 提供鉴权上下文与概览刷新能力
 * [OUTPUT]: 对外提供 useDashboardContactStore 联系人业务状态仓库与异步动作
 * [POS]: frontend dashboard 的联系人业务模块 store，独立管理联系人请求收发与处理状态
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

import { create } from "zustand";
import type { ContactRequestItem } from "@/lib/types";
import { api } from "@/lib/api";
import { useDashboardChatStore } from "@/store/useDashboardChatStore";
import { useDashboardSessionStore } from "@/store/useDashboardSessionStore";

interface DashboardContactState {
  pendingFriendRequests: string[];
  contactRequestsReceived: ContactRequestItem[];
  contactRequestsSent: ContactRequestItem[];
  contactRequestsLoading: boolean;
  processingContactRequestId: number | null;
  processingContactRequestAction: "accept" | "reject" | null;
  sendingContactRequestAgentId: string | null;

  markFriendRequestPending: (agentId: string) => void;
  resetContactState: () => void;
  loadContactRequests: () => Promise<void>;
  sendContactRequest: (toAgentId: string, message?: string) => Promise<void>;
  respondContactRequest: (requestId: number, action: "accept" | "reject") => Promise<void>;
}

const initialContactState = {
  pendingFriendRequests: [],
  contactRequestsReceived: [],
  contactRequestsSent: [],
  contactRequestsLoading: false,
  processingContactRequestId: null,
  processingContactRequestAction: null,
  sendingContactRequestAgentId: null,
};

function hasReadyAgent() {
  const { token, activeAgentId } = useDashboardSessionStore.getState();
  return Boolean(token && activeAgentId);
}

export const useDashboardContactStore = create<DashboardContactState>()((set, get) => ({
  ...initialContactState,

  markFriendRequestPending: (agentId) =>
    set((state) => ({
      pendingFriendRequests: state.pendingFriendRequests.includes(agentId)
        ? state.pendingFriendRequests
        : [...state.pendingFriendRequests, agentId],
    })),

  resetContactState: () => set({ ...initialContactState }),

  loadContactRequests: async () => {
    if (!hasReadyAgent()) {
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
    } catch {
      set({ contactRequestsLoading: false });
    }
  },

  sendContactRequest: async (toAgentId: string, message?: string) => {
    const { token } = useDashboardSessionStore.getState();
    if (!token) return;
    set({ sendingContactRequestAgentId: toAgentId });
    try {
      await api.createContactRequest({ to_agent_id: toAgentId, message });
      await get().loadContactRequests();
      set((state) => ({
        pendingFriendRequests: state.pendingFriendRequests.includes(toAgentId)
          ? state.pendingFriendRequests
          : [...state.pendingFriendRequests, toAgentId],
        sendingContactRequestAgentId: null,
      }));
    } catch (err) {
      set({ sendingContactRequestAgentId: null });
      throw err;
    }
  },

  respondContactRequest: async (requestId: number, action: "accept" | "reject") => {
    const { token } = useDashboardSessionStore.getState();
    if (!token) return;
    set({ processingContactRequestId: requestId, processingContactRequestAction: action });
    try {
      if (action === "accept") {
        await api.acceptContactRequest(requestId);
      } else {
        await api.rejectContactRequest(requestId);
      }
      const chatStore = useDashboardChatStore.getState();
      await Promise.all([chatStore.refreshOverview(), get().loadContactRequests()]);
      set({ processingContactRequestId: null, processingContactRequestAction: null });
    } catch (err) {
      set({ processingContactRequestId: null, processingContactRequestAction: null });
      throw err;
    }
  },
}));
