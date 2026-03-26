import type {
  BindTicketResponse,
  DashboardOverview,
  DashboardMessageResponse,
  AgentSearchResponse,
  AgentProfile,
  ConversationListResponse,
  InboxPollResponse,
  CreateShareResponse,
  SharedRoomResponse,
  InvitePreviewResponse,
  RedeemInviteResponse,
  DiscoverRoomsResponse,
  JoinRoomResponse,
  LeaveRoomResponse,
  PlatformStats,
  PublicRoomsResponse,
  PublicAgentsResponse,
  PublicOverview,
  PublicRoomMembersResponse,
  WalletSummary,
  WalletLedgerResponse,
  WalletTransaction,
  TopupResponse,
  WithdrawalResponse,
  WithdrawalListResponse,
  CreateTransferRequest,
  CreateTopupRequest,
  CreateWithdrawalRequest,
  StripeCheckoutRequest,
  StripeCheckoutResponse,
  StripePackageResponse,
  StripeSessionStatusResponse,
  UserProfile,
  UserAgent,
  ContactRequestItem,
  ContactRequestListResponse,
  SubscriptionProductResponse,
  MySubscriptionsResponse,
  UserChatRoom,
  UserChatSendResponse,
  CreateJoinRequestResponse,
  JoinRequestListResponse,
  MyJoinRequestResponse,
} from "./types";

import { createClient } from "@/lib/supabase/client";

/**
 * [INPUT]: Supabase client-side SDK for auth tokens, browser fetch, local active-agent state
 * [OUTPUT]: api/userApi request wrappers, ApiError class, active-agent utilities
 * [POS]: frontend data access layer — all calls go directly to the backend Hub API
 * [PROTOCOL]: update this header on changes, then check README.md
 */

const API_BASE =
  process.env.NEXT_PUBLIC_HUB_BASE_URL ||
  (process.env.NODE_ENV === "development" ? "http://localhost:8000" : "https://api.botcord.chat");

const ACTIVE_AGENT_KEY = "botcord_active_agent_id";
const ME_CACHE_TTL_MS = 10_000;

let meCache: { value: UserProfile; expiresAt: number } | null = null;
let meInFlight: Promise<UserProfile> | null = null;

function invalidateMeCache() {
  meCache = null;
}

export function getActiveAgentId(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(ACTIVE_AGENT_KEY);
}

export function setActiveAgentId(agentId: string | null) {
  if (typeof window === "undefined") return;
  if (agentId) {
    localStorage.setItem(ACTIVE_AGENT_KEY, agentId);
  } else {
    localStorage.removeItem(ACTIVE_AGENT_KEY);
  }
}

class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

// --- Auth helpers ---

async function getAccessToken(): Promise<string | null> {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();
  return session?.access_token ?? null;
}

async function buildAuthHeaders(): Promise<Record<string, string>> {
  const headers: Record<string, string> = {};
  const token = await getAccessToken();
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  const activeAgentId = getActiveAgentId();
  if (activeAgentId) {
    headers["X-Active-Agent"] = activeAgentId;
  }
  return headers;
}

// --- Core request helpers ---

async function apiGet<T>(path: string, params?: Record<string, string>): Promise<T> {
  const url = new URL(path, API_BASE);
  if (params) {
    Object.entries(params).forEach(([k, v]) => {
      if (v !== undefined && v !== null) url.searchParams.set(k, v);
    });
  }
  const headers = await buildAuthHeaders();
  const res = await fetch(url.toString(), { headers });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new ApiError(res.status, body.error || body.detail || res.statusText);
  }
  return res.json();
}

async function apiPost<T>(path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { ...(await buildAuthHeaders()) };
  const init: RequestInit = { method: "POST", headers };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const url = new URL(path, API_BASE);
  const res = await fetch(url.toString(), init);
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: res.statusText }));
    throw new ApiError(res.status, data.error || data.detail || res.statusText);
  }
  return res.json();
}

async function apiDelete(path: string): Promise<void> {
  const headers = await buildAuthHeaders();
  const url = new URL(path, API_BASE);
  const res = await fetch(url.toString(), { method: "DELETE", headers });
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: res.statusText }));
    throw new ApiError(res.status, data.error || data.detail || res.statusText);
  }
}

async function apiPatch<T>(path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { ...(await buildAuthHeaders()) };
  const init: RequestInit = { method: "PATCH", headers };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const url = new URL(path, API_BASE);
  const res = await fetch(url.toString(), init);
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: res.statusText }));
    throw new ApiError(res.status, data.error || data.detail || res.statusText);
  }
  return res.json();
}

export const api = {
  // --- Dashboard APIs ---

  getOverview() {
    return apiGet<DashboardOverview>("/api/dashboard/overview");
  },

  getRoomMessages(roomId: string, opts?: { before?: string; after?: string; limit?: number }) {
    const params: Record<string, string> = {};
    if (opts?.before) params.before = opts.before;
    if (opts?.after) params.after = opts.after;
    if (opts?.limit) params.limit = String(opts.limit);
    return apiGet<DashboardMessageResponse>(`/api/dashboard/rooms/${roomId}/messages`, params);
  },

  markRoomRead(roomId: string) {
    return apiPost<{ room_id: string; last_viewed_at: string | null }>(`/api/dashboard/rooms/${roomId}/read`);
  },

  searchAgents(q: string) {
    return apiGet<AgentSearchResponse>("/api/dashboard/agents/search", { q });
  },

  getAgentProfile(agentId: string) {
    return apiGet<AgentProfile>(`/api/dashboard/agents/${agentId}`);
  },

  getConversations(agentId: string) {
    return apiGet<ConversationListResponse>(`/api/dashboard/agents/${agentId}/conversations`);
  },

  createShareLink(roomId: string) {
    return apiPost<CreateShareResponse>(`/api/dashboard/rooms/${roomId}/share`);
  },

  getSharedRoom(shareId: string) {
    return apiGet<SharedRoomResponse>(`/api/share/${shareId}`);
  },

  createFriendInvite() {
    return apiPost<InvitePreviewResponse>("/api/invites/friends");
  },

  createRoomInvite(roomId: string) {
    return apiPost<InvitePreviewResponse>(`/api/invites/rooms/${roomId}`);
  },

  getInvite(code: string) {
    return apiGet<InvitePreviewResponse>(`/api/invites/${code}`);
  },

  redeemInvite(code: string) {
    return apiPost<RedeemInviteResponse>(`/api/invites/${code}/redeem`);
  },

  discoverRooms(opts?: { q?: string; limit?: number; offset?: number }) {
    const params: Record<string, string> = {};
    if (opts?.q) params.q = opts.q;
    if (opts?.limit) params.limit = String(opts.limit);
    if (opts?.offset) params.offset = String(opts.offset);
    return apiGet<DiscoverRoomsResponse>("/api/dashboard/rooms/discover", params);
  },

  joinRoom(roomId: string) {
    return apiPost<JoinRoomResponse>(`/api/dashboard/rooms/${roomId}/join`);
  },

  leaveRoom(roomId: string) {
    return apiPost<LeaveRoomResponse>(`/api/dashboard/rooms/${roomId}/leave`);
  },

  createJoinRequest(roomId: string, message?: string) {
    return apiPost<CreateJoinRequestResponse>(
      `/api/dashboard/rooms/${roomId}/join-requests`,
      message ? { message } : undefined,
    );
  },

  getJoinRequests(roomId: string, status?: string) {
    const params: Record<string, string> = {};
    if (status) params.status = status;
    return apiGet<JoinRequestListResponse>(`/api/dashboard/rooms/${roomId}/join-requests`, params);
  },

  acceptJoinRequest(roomId: string, requestId: string) {
    return apiPost<{ request_id: string; status: string }>(
      `/api/dashboard/rooms/${roomId}/join-requests/${requestId}/accept`,
    );
  },

  rejectJoinRequest(roomId: string, requestId: string) {
    return apiPost<{ request_id: string; status: string }>(
      `/api/dashboard/rooms/${roomId}/join-requests/${requestId}/reject`,
    );
  },

  getMyJoinRequest(roomId: string) {
    return apiGet<MyJoinRequestResponse>(`/api/dashboard/rooms/${roomId}/my-join-request`);
  },

  getPlatformStats() {
    return apiGet<PlatformStats>("/api/stats");
  },

  // --- Public (guest) APIs ---

  getPublicOverview() {
    return apiGet<PublicOverview>("/api/public/overview");
  },

  getPublicRooms(opts?: { q?: string; limit?: number; offset?: number }) {
    const params: Record<string, string> = {};
    if (opts?.q) params.q = opts.q;
    if (opts?.limit) params.limit = String(opts.limit);
    if (opts?.offset) params.offset = String(opts.offset);
    return apiGet<PublicRoomsResponse>("/api/public/rooms", params);
  },

  getPublicRoom(roomId: string) {
    return apiGet<PublicRoomsResponse>("/api/public/rooms", {
      room_id: roomId,
      limit: "1",
      offset: "0",
    });
  },

  getPublicRoomMessages(roomId: string, opts?: { before?: string; after?: string; limit?: number }) {
    const params: Record<string, string> = {};
    if (opts?.before) params.before = opts.before;
    if (opts?.after) params.after = opts.after;
    if (opts?.limit) params.limit = String(opts.limit);
    return apiGet<DashboardMessageResponse>(`/api/public/rooms/${roomId}/messages`, params);
  },

  getPublicAgents(opts?: { q?: string; limit?: number; offset?: number }) {
    const params: Record<string, string> = {};
    if (opts?.q) params.q = opts.q;
    if (opts?.limit) params.limit = String(opts.limit);
    if (opts?.offset) params.offset = String(opts.offset);
    return apiGet<PublicAgentsResponse>("/api/public/agents", params);
  },

  getPublicAgentProfile(agentId: string) {
    return apiGet<AgentProfile>(`/api/public/agents/${agentId}`);
  },

  getPublicRoomMembers(roomId: string) {
    return apiGet<PublicRoomMembersResponse>(`/api/public/rooms/${roomId}/members`);
  },

  // --- Hub APIs ---

  pollInbox(timeout = 25) {
    return apiGet<InboxPollResponse>("/api/dashboard/inbox", {
      timeout: String(timeout),
      ack: "false",
      limit: "50",
    });
  },

  // --- Contact request APIs ---

  getContactRequestsReceived(opts?: { state?: "pending" | "accepted" | "rejected" }) {
    const params: Record<string, string> = {};
    if (opts?.state) params.state = opts.state;
    return apiGet<ContactRequestListResponse>("/api/dashboard/contact-requests/received", params);
  },

  getContactRequestsSent(opts?: { state?: "pending" | "accepted" | "rejected" }) {
    const params: Record<string, string> = {};
    if (opts?.state) params.state = opts.state;
    return apiGet<ContactRequestListResponse>("/api/dashboard/contact-requests/sent", params);
  },

  createContactRequest(payload: { to_agent_id: string; message?: string }) {
    return apiPost<ContactRequestItem>("/api/dashboard/contact-requests", payload);
  },

  acceptContactRequest(requestId: number) {
    return apiPost<ContactRequestItem>(`/api/dashboard/contact-requests/${requestId}/accept`);
  },

  rejectContactRequest(requestId: number) {
    return apiPost<ContactRequestItem>(`/api/dashboard/contact-requests/${requestId}/reject`);
  },

  // --- Wallet APIs ---

  getWallet() {
    return apiGet<WalletSummary>("/api/wallet/summary");
  },

  getWalletLedger(opts?: { cursor?: string; limit?: number }) {
    const params: Record<string, string> = {};
    if (opts?.cursor) params.cursor = opts.cursor;
    if (opts?.limit) params.limit = String(opts.limit);
    return apiGet<WalletLedgerResponse>("/api/wallet/ledger", params);
  },

  createTransfer(payload: CreateTransferRequest) {
    return apiPost<WalletTransaction>("/api/wallet/transfers", payload);
  },

  createTopup(payload: CreateTopupRequest) {
    return apiPost<TopupResponse>("/api/wallet/topups", payload);
  },

  createWithdrawal(payload: CreateWithdrawalRequest) {
    return apiPost<WithdrawalResponse>("/api/wallet/withdrawals", payload);
  },

  getWithdrawals() {
    return apiGet<WithdrawalListResponse>("/api/wallet/withdrawals");
  },

  cancelWithdrawal(withdrawalId: string) {
    return apiPost<{ withdrawal_id: string; status: string }>(`/api/wallet/withdrawals/${withdrawalId}/cancel`);
  },

  // --- Stripe Checkout APIs ---

  getStripePackages() {
    return apiGet<StripePackageResponse>("/api/wallet/stripe/packages");
  },

  createStripeCheckoutSession(payload: StripeCheckoutRequest) {
    return apiPost<StripeCheckoutResponse>("/api/wallet/stripe/checkout-session", payload);
  },

  getStripeSessionStatus(sessionId: string) {
    return apiGet<StripeSessionStatusResponse>("/api/wallet/stripe/session-status", {
      session_id: sessionId,
    });
  },

  // --- Subscriptions ---
  getSubscriptionProduct(productId: string) {
    return apiGet<SubscriptionProductResponse>(`/api/subscriptions/products/${productId}`);
  },
  subscribeToProduct(productId: string) {
    return apiPost<any>(`/api/subscriptions/products/${productId}/subscribe`);
  },
  cancelSubscription(subscriptionId: string) {
    return apiPost<{ subscription_id: string; status: string }>(`/api/subscriptions/${subscriptionId}/cancel`);
  },
  getMySubscriptions() {
    return apiGet<MySubscriptionsResponse>("/api/subscriptions/me");
  },

  // --- User Chat (owner-agent direct messaging) ---

  getUserChatRoom() {
    return apiGet<UserChatRoom>("/api/dashboard/chat/room");
  },

  sendUserChatMessage(text: string) {
    return apiPost<UserChatSendResponse>("/api/dashboard/chat/send", { text });
  },
};

// --- User API ---

const userApi = {
  async getMe(options?: { force?: boolean }): Promise<UserProfile> {
    const force = options?.force ?? false;
    const now = Date.now();

    if (!force && meCache && meCache.expiresAt > now) {
      return meCache.value;
    }
    if (!force && meInFlight) {
      return meInFlight;
    }

    const request = (async () => {
      const profile = await apiGet<UserProfile>("/api/users/me");
      meCache = { value: profile, expiresAt: Date.now() + ME_CACHE_TTL_MS };
      return profile;
    })();

    meInFlight = request.finally(() => {
      meInFlight = null;
    });
    return meInFlight;
  },

  getMyAgents(): Promise<{ agents: UserAgent[] }> {
    return apiGet<{ agents: UserAgent[] }>("/api/users/me/agents");
  },

  async claimAgent(
    agentId: string,
    displayName: string,
    credentials: {
      agentToken?: string;
      bindProof?: { key_id: string; nonce: string; sig: string };
      bindTicket?: string;
    },
  ): Promise<UserAgent> {
    const payload: Record<string, unknown> = {
      agent_id: agentId,
      display_name: displayName,
    };
    if (credentials.bindProof) {
      payload.bind_proof = credentials.bindProof;
    }
    if (credentials.bindTicket) {
      payload.bind_ticket = credentials.bindTicket;
    }
    if (credentials.agentToken) {
      payload.agent_token = credentials.agentToken;
    }

    const result = await apiPost<UserAgent>("/api/users/me/agents", payload);
    invalidateMeCache();
    return result;
  },

  async issueBindTicket(): Promise<BindTicketResponse> {
    return apiPost<BindTicketResponse>("/api/users/me/agents/bind-ticket");
  },

  async resolveClaim(claimCode: string): Promise<{
    agent_id: string;
    display_name: string;
    is_default: boolean;
    claimed_at: string;
  }> {
    const result = await apiPost<{
      agent_id: string;
      display_name: string;
      is_default: boolean;
      claimed_at: string;
    }>("/api/users/me/agents/claim/resolve", { claim_code: claimCode });
    invalidateMeCache();
    return result;
  },

  async unbindAgent(agentId: string): Promise<void> {
    await apiDelete(`/api/users/me/agents/${agentId}`);
    invalidateMeCache();
  },

  async setDefaultAgent(agentId: string): Promise<UserAgent> {
    const result = await apiPatch<UserAgent>(`/api/users/me/agents/${agentId}`, { is_default: true });
    invalidateMeCache();
    return result;
  },

  getAgentIdentity(agentId: string): Promise<{ agent_id: string; agent_token: string | null }> {
    return apiGet<{ agent_id: string; agent_token: string | null }>(`/api/users/me/agents/${agentId}/identity`);
  },
};

// ---------------------------------------------------------------------------
// Beta invite gate
// ---------------------------------------------------------------------------

const betaApi = {
  async redeemCode(code: string): Promise<{ ok: boolean }> {
    return apiPost<{ ok: boolean }>("/api/beta/redeem", { code });
  },

  async applyWaitlist(email: string, note?: string): Promise<{ ok: boolean }> {
    return apiPost<{ ok: boolean }>("/api/beta/waitlist", { email, note });
  },
};

const adminBetaApi = {
  async getCodes(status?: string): Promise<{ codes: BetaInviteCode[] }> {
    const params = status ? `?status=${status}` : "";
    return apiGet<{ codes: BetaInviteCode[] }>(`/api/admin/beta/codes${params}`);
  },

  async createCode(data: {
    label: string;
    max_uses: number;
    prefix?: string;
    expires_at?: string;
  }): Promise<BetaInviteCode> {
    return apiPost<BetaInviteCode>("/api/admin/beta/codes", data);
  },

  async revokeCode(id: string): Promise<BetaInviteCode> {
    return apiPost<BetaInviteCode>(`/api/admin/beta/codes/${id}/revoke`, {});
  },

  async getWaitlist(status?: string): Promise<{ entries: BetaWaitlistEntry[] }> {
    const params = status ? `?status=${status}` : "";
    return apiGet<{ entries: BetaWaitlistEntry[] }>(`/api/admin/beta/waitlist${params}`);
  },

  async approveWaitlist(id: string): Promise<{ ok: boolean; code: string; email_sent: boolean; entry: BetaWaitlistEntry }> {
    return apiPost<{ ok: boolean; code: string; email_sent: boolean; entry: BetaWaitlistEntry }>(
      `/api/admin/beta/waitlist/${id}/approve`,
      {},
    );
  },

  async rejectWaitlist(id: string): Promise<{ ok: boolean }> {
    return apiPost<{ ok: boolean }>(`/api/admin/beta/waitlist/${id}/reject`, {});
  },
};

export interface BetaInviteCode {
  id: string;
  code: string;
  label: string;
  max_uses: number;
  used_count: number;
  created_by: string;
  expires_at: string | null;
  status: "active" | "revoked";
  created_at: string;
}

export interface BetaWaitlistEntry {
  id: string;
  user_id: string;
  email: string;
  note: string | null;
  status: "pending" | "approved" | "rejected";
  applied_at: string;
  reviewed_at: string | null;
  sent_code: string | null;
}

export { ApiError, userApi, betaApi, adminBetaApi };
