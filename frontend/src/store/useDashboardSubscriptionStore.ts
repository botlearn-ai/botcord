/**
 * [INPUT]: 依赖 zustand 保存订阅域状态，依赖 @/lib/api 发起订阅查询/订阅/退订请求，依赖 session store 提供当前身份上下文
 * [OUTPUT]: 对外提供 useDashboardSubscriptionStore 订阅业务域仓库与订阅生命周期动作
 * [POS]: frontend dashboard 的订阅真相源，统一管理当前 agent 的订阅列表与商品级订阅状态
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

import { create } from "zustand";
import type { AgentSubscription } from "@/lib/types";
import { api } from "@/lib/api";
import { useDashboardSessionStore } from "@/store/useDashboardSessionStore";

interface DashboardSubscriptionState {
  subscriptionsByAgent: Record<string, AgentSubscription[]>;
  subscriptionsLoading: boolean;
  subscriptionsError: string | null;

  resetSubscriptionState: () => void;
  getSubscriptionsForAgent: (agentId: string | null) => AgentSubscription[];
  getActiveSubscription: (productId: string) => AgentSubscription | null;
  ensureSubscriptions: () => Promise<AgentSubscription[]>;
  refreshSubscriptions: () => Promise<AgentSubscription[]>;
  subscribeToProduct: (productId: string, opts?: { roomId?: string }) => Promise<AgentSubscription | null>;
  cancelSubscription: (subscriptionId: string) => Promise<AgentSubscription[]>;
  upsertRoomPlan: (
    roomId: string,
    body: {
      amount_minor: string;
      billing_interval: "week" | "month";
      description?: string;
      currentProductId?: string | null;
      // Required when the room is human-owned, ignored otherwise.
      providerAgentId?: string;
    },
  ) => Promise<{ productId: string; affectedCount: number }>;
}

const initialSubscriptionState = {
  subscriptionsByAgent: {},
  subscriptionsLoading: false,
  subscriptionsError: null,
};

function getReadyAgentId(): string | null {
  const { token, activeAgentId, activeIdentity } = useDashboardSessionStore.getState();
  if (!token || !activeAgentId || activeIdentity?.type !== "agent") return null;
  return activeAgentId;
}

export const useDashboardSubscriptionStore = create<DashboardSubscriptionState>()((set, get) => ({
  ...initialSubscriptionState,

  resetSubscriptionState: () => set({ ...initialSubscriptionState }),

  getSubscriptionsForAgent: (agentId) => (agentId ? get().subscriptionsByAgent[agentId] || [] : []),

  getActiveSubscription: (productId) => {
    const agentId = getReadyAgentId();
    if (!agentId) return null;
    return get().getSubscriptionsForAgent(agentId).find(
      (item) => item.product_id === productId && item.status === "active",
    ) || null;
  },

  ensureSubscriptions: async () => {
    const agentId = getReadyAgentId();
    if (!agentId) {
      set({ subscriptionsError: null, subscriptionsLoading: false });
      return [];
    }

    const cached = get().subscriptionsByAgent[agentId];
    if (cached) {
      return cached;
    }

    set({ subscriptionsLoading: true, subscriptionsError: null });
    try {
      const result = await api.getMySubscriptions();
      set((state) => ({
        subscriptionsByAgent: {
          ...state.subscriptionsByAgent,
          [agentId]: result.subscriptions,
        },
        subscriptionsLoading: false,
        subscriptionsError: null,
      }));
      return result.subscriptions;
    } catch (err: any) {
      const message = err?.message || "Failed to load subscriptions";
      set({ subscriptionsLoading: false, subscriptionsError: message });
      throw err;
    }
  },

  refreshSubscriptions: async () => {
    const agentId = getReadyAgentId();
    if (!agentId) {
      set({ subscriptionsError: null, subscriptionsLoading: false });
      return [];
    }

    set({ subscriptionsLoading: true, subscriptionsError: null });
    try {
      const result = await api.getMySubscriptions();
      set((state) => ({
        subscriptionsByAgent: {
          ...state.subscriptionsByAgent,
          [agentId]: result.subscriptions,
        },
        subscriptionsLoading: false,
        subscriptionsError: null,
      }));
      return result.subscriptions;
    } catch (err: any) {
      const message = err?.message || "Failed to refresh subscriptions";
      set({ subscriptionsLoading: false, subscriptionsError: message });
      throw err;
    }
  },

  subscribeToProduct: async (productId, opts) => {
    await api.subscribeToProduct(productId, opts);
    const subscriptions = await get().refreshSubscriptions();
    return subscriptions.find(
      (item) => item.product_id === productId && item.status === "active",
    ) || null;
  },

  cancelSubscription: async (subscriptionId) => {
    await api.cancelSubscription(subscriptionId);
    return get().refreshSubscriptions();
  },

  upsertRoomPlan: async (roomId, body) => {
    // Single code path: migrate-plan creates + binds + archives atomically,
    // and works without X-Active-Agent (human-as-owner) once the human path
    // sends provider_agent_id explicitly.
    const result = await api.migrateRoomSubscriptionPlan(roomId, {
      amount_minor: body.amount_minor,
      billing_interval: body.billing_interval,
      description: body.description,
      provider_agent_id: body.providerAgentId,
    });
    return { productId: result.product_id, affectedCount: result.affected_count };
  },
}));
