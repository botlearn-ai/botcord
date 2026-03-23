import type {
  DashboardOverview,
  DashboardMessageResponse,
  AgentSearchResponse,
  AgentProfile,
  ConversationListResponse,
  InboxPollResponse,
  CreateShareResponse,
  SharedRoomResponse,
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
} from "./types";

/**
 * [INPUT]: 依赖浏览器 fetch 与本地 active-agent 状态，依赖 /api/* BFF 路由与公开 Hub API
 * [OUTPUT]: 对外提供 api/userApi 请求封装、错误类型 ApiError 与 active-agent 工具函数
 * [POS]: frontend 数据访问层入口，统一 Dashboard 与用户绑定相关网络调用
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
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

function buildHeaders(token: string): Record<string, string> {
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  const activeAgentId = getActiveAgentId();
  if (activeAgentId) {
    headers["X-Active-Agent"] = activeAgentId;
  }
  return headers;
}

async function request<T>(path: string, token: string, params?: Record<string, string>): Promise<T> {
  const url = new URL(path, API_BASE);
  if (params) {
    Object.entries(params).forEach(([k, v]) => {
      if (v !== undefined && v !== null) url.searchParams.set(k, v);
    });
  }
  const fullUrl = url.toString();
  console.log(`[API] → ${path}`, fullUrl);
  try {
    const res = await fetch(fullUrl, {
      headers: buildHeaders(token),
    });
    console.log(`[API] ← ${path} status=${res.status}`);
    if (!res.ok) {
      const body = await res.json().catch(() => ({ detail: res.statusText }));
      console.error(`[API] ✗ ${path} error:`, res.status, body);
      throw new ApiError(res.status, body.detail || res.statusText);
    }
    const data = await res.json();
    console.log(`[API] ✓ ${path} response:`, data);
    return data;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    console.error(`[API] ✗ ${path} network error:`, err);
    throw err;
  }
}

// --- Cookie-session request helpers (for migrated /api/* routes) ---

function buildCookieHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  const activeAgentId = getActiveAgentId();
  if (activeAgentId) {
    headers["X-Active-Agent"] = activeAgentId;
  }
  return headers;
}

async function apiGet<T>(path: string, params?: Record<string, string>): Promise<T> {
  const url = new URL(path, window.location.origin);
  if (params) {
    Object.entries(params).forEach(([k, v]) => {
      if (v !== undefined && v !== null) url.searchParams.set(k, v);
    });
  }
  const res = await fetch(url.toString(), { headers: buildCookieHeaders() });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new ApiError(res.status, body.error || body.detail || res.statusText);
  }
  return res.json();
}

async function apiPost<T>(path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { ...buildCookieHeaders() };
  const init: RequestInit = { method: "POST", headers };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const res = await fetch(path, init);
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: res.statusText }));
    throw new ApiError(res.status, data.error || data.detail || res.statusText);
  }
  return res.json();
}

export const api = {
  // --- Dashboard APIs (migrated to frontend /api/*) ---

  getOverview() {
    return apiGet<DashboardOverview>("/api/dashboard/overview");
  },

  getRoomMessages(roomId: string, opts?: { before?: string; after?: string; limit?: number }) {
    const params: Record<string, string> = {};
    if (opts?.before) params.before = opts.before;
    if (opts?.after) params.after = opts.after;
    if (opts?.limit) params.limit = String(opts.limit);
    return apiGet<DashboardMessageResponse>(`/api/rooms/${roomId}/messages`, params);
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

  getPlatformStats() {
    return apiGet<PlatformStats>("/api/stats");
  },

  // --- Public (guest) APIs (migrated to frontend /api/*) ---

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
    return apiGet<DashboardMessageResponse>(`/api/rooms/${roomId}/messages`, params);
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

  pollInbox(_token: string, timeout = 25) {
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

  // --- Wallet APIs (migrated to frontend /api/*) ---

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
  // --- Stripe Checkout APIs (migrated to frontend /api/*) ---

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

// --- User API (Next.js API Routes) ---

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
      const res = await fetch("/api/users/me");
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: res.statusText }));
        throw new ApiError(res.status, data.error || res.statusText);
      }
      const profile = (await res.json()) as UserProfile;
      meCache = { value: profile, expiresAt: Date.now() + ME_CACHE_TTL_MS };
      return profile;
    })();

    meInFlight = request.finally(() => {
      meInFlight = null;
    });
    return meInFlight;
  },

  async getMyAgents(): Promise<{ agents: UserAgent[] }> {
    const res = await fetch("/api/users/me/agents");
    if (!res.ok) {
      const data = await res.json().catch(() => ({ error: res.statusText }));
      throw new ApiError(res.status, data.error || res.statusText);
    }
    return res.json();
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

    const res = await fetch("/api/users/me/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({ error: res.statusText }));
      throw new ApiError(res.status, data.error || res.statusText);
    }
    invalidateMeCache();
    return res.json();
  },

  async issueBindTicket(): Promise<{ bind_ticket: string; nonce: string; expires_at: number }> {
    const res = await fetch("/api/users/me/agents/bind-ticket", {
      method: "POST",
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({ error: res.statusText }));
      throw new ApiError(res.status, data.error || res.statusText);
    }
    return res.json();
  },

  async resolveClaim(claimCode: string): Promise<{
    agent_id: string;
    display_name: string;
    is_default: boolean;
    claimed_at: string;
  }> {
    const res = await fetch("/api/users/me/agents/claim/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ claim_code: claimCode }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({ error: res.statusText }));
      throw new ApiError(res.status, data.error || res.statusText);
    }
    invalidateMeCache();
    return res.json();
  },

  async unbindAgent(agentId: string): Promise<void> {
    const res = await fetch(`/api/users/me/agents/${agentId}`, { method: "DELETE" });
    if (!res.ok) {
      const data = await res.json().catch(() => ({ error: res.statusText }));
      throw new ApiError(res.status, data.error || res.statusText);
    }
    invalidateMeCache();
  },

  async setDefaultAgent(agentId: string): Promise<UserAgent> {
    const res = await fetch(`/api/users/me/agents/${agentId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ is_default: true }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({ error: res.statusText }));
      throw new ApiError(res.status, data.error || res.statusText);
    }
    invalidateMeCache();
    return res.json();
  },
};

export { ApiError, userApi };
