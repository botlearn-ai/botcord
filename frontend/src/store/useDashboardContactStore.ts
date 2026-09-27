/**
 * [INPUT]: 依赖 zustand 保存联系人域状态，依赖 @/lib/api 发起联系人请求，依赖 chat store 提供鉴权上下文与概览刷新能力
 * [OUTPUT]: 对外提供 useDashboardContactStore 联系人业务状态仓库与异步动作
 * [POS]: frontend dashboard 的联系人业务模块 store，按来源渐进加载联系人请求，复用审批请求并隔离身份切换后的过期结果
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

import { create } from "zustand";
import type { ContactRequestItem, HumanContactRequestSummary } from "@/lib/types";
import { api, humansApi } from "@/lib/api";
import { useDashboardChatStore } from "@/store/useDashboardChatStore";
import { useDashboardSessionStore } from "@/store/useDashboardSessionStore";

interface DashboardContactState {
  pendingFriendRequests: string[];
  contactRequestsReceived: ContactRequestItem[];
  contactRequestsSent: ContactRequestItem[];
  contactRequestsBotApprovalCount: number;
  contactRequestsLoading: boolean;
  processingContactRequestId: number | string | null;
  processingContactRequestAction: "accept" | "reject" | null;
  sendingContactRequestAgentId: string | null;

  markFriendRequestPending: (agentId: string) => void;
  resetContactState: () => void;
  loadContactRequests: () => Promise<void>;
  sendContactRequest: (toAgentId: string, message?: string) => Promise<void>;
  respondContactRequest: (requestId: number | string, action: "accept" | "reject") => Promise<void>;
}

const initialContactState = {
  pendingFriendRequests: [],
  contactRequestsReceived: [],
  contactRequestsSent: [],
  contactRequestsBotApprovalCount: 0,
  contactRequestsLoading: false,
  processingContactRequestId: null,
  processingContactRequestAction: null,
  sendingContactRequestAgentId: null,
};

let contactRequestsInFlight: { scope: string; promise: Promise<void> } | null = null;
let contactGeneration = 0;
let approvalsInFlight: { scope: string; promise: ReturnType<typeof humansApi.listPendingApprovals> } | null = null;

function contactActorScope(state: ReturnType<typeof useDashboardSessionStore.getState>) {
  const { token, user, activeAgentId, activeIdentity, viewMode, human } = state;
  const humanSurface = activeIdentity?.type === "human" || viewMode === "human";
  return JSON.stringify([
    Boolean(token), user?.id ?? null,
    humanSurface ? "human" : "agent",
    humanSurface ? human?.human_id ?? null : activeAgentId,
    activeIdentity?.type ?? null, activeIdentity?.id ?? null,
  ]);
}

export function contactRequestScope() {
  const state = useDashboardSessionStore.getState();
  return JSON.stringify([contactGeneration, state.token, contactActorScope(state)]);
}

// Both the requests inbox and the sidebar count need this same endpoint.
export function loadPendingContactApprovals() {
  const scope = contactRequestScope();
  if (approvalsInFlight?.scope === scope) return approvalsInFlight.promise;
  const promise = humansApi.listPendingApprovals().finally(() => {
    if (approvalsInFlight?.promise === promise) approvalsInFlight = null;
  });
  approvalsInFlight = { scope, promise };
  return promise;
}

function isHumanContactSurface() {
  const { activeIdentity, viewMode } = useDashboardSessionStore.getState();
  return activeIdentity?.type === "human" || viewMode === "human";
}

function hasReadyContactIdentity() {
  const { token, activeAgentId, activeIdentity, viewMode, human } = useDashboardSessionStore.getState();
  if (!token) return false;
  if (activeIdentity?.type === "human" || viewMode === "human") {
    return Boolean(human?.human_id);
  }
  return Boolean(activeAgentId);
}

function normalizeHumanContactRequest(item: HumanContactRequestSummary): ContactRequestItem {
  return {
    id: item.id,
    from_agent_id: item.from_participant_id,
    to_agent_id: item.to_participant_id,
    state: item.state,
    message: item.message,
    created_at: new Date(item.created_at * 1000).toISOString(),
    resolved_at: null,
    from_display_name: item.from_display_name,
    to_display_name: item.to_display_name,
    from_avatar_url: item.from_avatar_url,
    to_avatar_url: item.to_avatar_url,
  };
}

export const useDashboardContactStore = create<DashboardContactState>()((set, get) => ({
  ...initialContactState,

  markFriendRequestPending: (agentId) =>
    set((state) => ({
      pendingFriendRequests: state.pendingFriendRequests.includes(agentId)
        ? state.pendingFriendRequests
        : [...state.pendingFriendRequests, agentId],
    })),

  resetContactState: () => {
    contactGeneration += 1;
    contactRequestsInFlight = null;
    approvalsInFlight = null;
    set({ ...initialContactState });
  },

  loadContactRequests: async () => {
    const scope = contactRequestScope();
    if (contactRequestsInFlight?.scope === scope) return contactRequestsInFlight.promise;
    if (!hasReadyContactIdentity()) {
      set({
        contactRequestsReceived: [], contactRequestsSent: [],
        contactRequestsBotApprovalCount: 0, contactRequestsLoading: false,
      });
      return;
    }
    const isCurrent = () => contactRequestScope() === scope;
    const humanSurface = isHumanContactSurface();
    set({ contactRequestsLoading: true });
    // Publish each independent source as soon as it arrives. A slow Sent or
    // bot-approval response must not hold up actionable Received requests.
    const received = (humanSurface
      ? humansApi.listReceivedContactRequests().then((res) => res.requests.map(normalizeHumanContactRequest))
      : api.getContactRequestsReceived().then((res) => res.requests)
    ).then((requests) => {
      if (isCurrent()) set({ contactRequestsReceived: requests });
    });
    const sent = (humanSurface
      ? humansApi.listSentContactRequests().then((res) => res.requests.map(normalizeHumanContactRequest))
      : api.getContactRequestsSent().then((res) => res.requests)
    ).then((requests) => {
      if (!isCurrent()) return;
      const targets = requests.filter((item) => item.state === "pending").map((item) => item.to_agent_id);
      set({
        contactRequestsSent: requests,
        pendingFriendRequests: Array.from(new Set([...get().pendingFriendRequests, ...targets])),
      });
    });
    const approvals = humanSurface
      ? loadPendingContactApprovals().then((res) => {
          if (isCurrent()) set({ contactRequestsBotApprovalCount: res.approvals.filter((approval) => (
            approval.kind === "contact_request" && !approval.id.startsWith("cr_")
          )).length });
        })
      : Promise.resolve().then(() => {
          if (isCurrent()) set({ contactRequestsBotApprovalCount: 0 });
        });
    const promise = Promise.allSettled([received, sent, approvals]).then(() => {
      if (isCurrent()) set({ contactRequestsLoading: false });
    }).finally(() => {
      if (contactRequestsInFlight?.promise === promise) contactRequestsInFlight = null;
    });
    contactRequestsInFlight = { scope, promise };
    return promise;
  },

  sendContactRequest: async (toAgentId: string, message?: string) => {
    const { token } = useDashboardSessionStore.getState();
    if (!token) return;
    const scope = contactRequestScope();
    set({ sendingContactRequestAgentId: toAgentId });
    try {
      if (isHumanContactSurface()) {
        await humansApi.sendContactRequest({ peer_id: toAgentId, message });
      } else {
        await api.createContactRequest({ to_agent_id: toAgentId, message });
      }
      if (contactRequestScope() !== scope) return;
      const chatStore = useDashboardChatStore.getState();
      await Promise.all([chatStore.refreshOverview(), get().loadContactRequests()]);
      if (contactRequestScope() !== scope) return;
      set((state) => ({
        pendingFriendRequests: state.pendingFriendRequests.includes(toAgentId)
          ? state.pendingFriendRequests
          : [...state.pendingFriendRequests, toAgentId],
        sendingContactRequestAgentId: null,
      }));
    } catch (err) {
      if (contactRequestScope() !== scope) return;
      set({ sendingContactRequestAgentId: null });
      throw err;
    }
  },

  respondContactRequest: async (requestId: number | string, action: "accept" | "reject") => {
    const { token } = useDashboardSessionStore.getState();
    if (!token) return;
    const scope = contactRequestScope();
    set({ processingContactRequestId: requestId, processingContactRequestAction: action });
    try {
      if (action === "accept") {
        if (isHumanContactSurface()) {
          await humansApi.acceptContactRequest(String(requestId));
        } else {
          await api.acceptContactRequest(Number(requestId));
        }
      } else {
        if (isHumanContactSurface()) {
          await humansApi.rejectContactRequest(String(requestId));
        } else {
          await api.rejectContactRequest(Number(requestId));
        }
      }
      if (contactRequestScope() !== scope) return;
      const chatStore = useDashboardChatStore.getState();
      await Promise.all([chatStore.refreshOverview(), get().loadContactRequests()]);
      if (contactRequestScope() !== scope) return;
      set({ processingContactRequestId: null, processingContactRequestAction: null });
    } catch (err) {
      if (contactRequestScope() !== scope) return;
      set({ processingContactRequestId: null, processingContactRequestAction: null });
      throw err;
    }
  },
}));

// Clear private data in the same synchronous session update that changes its
// owner. Consumers must never wait for a pane effect or a new API response to
// stop showing the previous identity's requests or action state.
useDashboardSessionStore.subscribe((state, previous) => {
  if (contactActorScope(state) !== contactActorScope(previous)) {
    useDashboardContactStore.getState().resetContactState();
  } else if (state.token !== previous.token) {
    // Credential rotation for the same actor retains readable cached data,
    // but releases flags for the old requests whose responses are discarded.
    contactGeneration += 1;
    contactRequestsInFlight = null;
    approvalsInFlight = null;
    useDashboardContactStore.setState({
      contactRequestsLoading: false,
      processingContactRequestId: null,
      processingContactRequestAction: null,
      sendingContactRequestAgentId: null,
    });
  }
});
