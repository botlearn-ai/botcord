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
  PlatformStats,
  PublicRoomsResponse,
  PublicAgentsResponse,
  PublicOverview,
  PublicRoomMembersResponse,
  TopicListResponse,
  WalletSummary,
  WalletLedgerResponse,
  WalletTransaction,
  TopupResponse,
  WithdrawalResponse,
  CreateTransferRequest,
  CreateTopupRequest,
  CreateWithdrawalRequest,
  StripeCheckoutRequest,
  StripeCheckoutResponse,
  StripePackageResponse,
  StripeSessionStatusResponse,
  UserProfile,
  UserAgent,
} from "./types";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE || "https://api.botcord.chat";

const ACTIVE_AGENT_KEY = "botcord_active_agent_id";

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

async function postRequest<T>(path: string, token: string): Promise<T> {
  const url = new URL(path, API_BASE);
  const fullUrl = url.toString();
  console.log(`[API] → POST ${path}`, fullUrl);
  try {
    const res = await fetch(fullUrl, {
      method: "POST",
      headers: buildHeaders(token),
    });
    console.log(`[API] ← POST ${path} status=${res.status}`);
    if (!res.ok) {
      const body = await res.json().catch(() => ({ detail: res.statusText }));
      console.error(`[API] ✗ POST ${path} error:`, res.status, body);
      throw new ApiError(res.status, body.detail || res.statusText);
    }
    const data = await res.json();
    console.log(`[API] ✓ POST ${path} response:`, data);
    return data;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    console.error(`[API] ✗ POST ${path} network error:`, err);
    throw err;
  }
}

async function postJsonRequest<T>(path: string, token: string, body: unknown): Promise<T> {
  const url = new URL(path, API_BASE);
  const fullUrl = url.toString();
  console.log(`[API] → POST ${path}`, fullUrl);
  try {
    const res = await fetch(fullUrl, {
      method: "POST",
      headers: {
        ...buildHeaders(token),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    console.log(`[API] ← POST ${path} status=${res.status}`);
    if (!res.ok) {
      const data = await res.json().catch(() => ({ detail: res.statusText }));
      console.error(`[API] ✗ POST ${path} error:`, res.status, data);
      throw new ApiError(res.status, data.detail || res.statusText);
    }
    const data = await res.json();
    console.log(`[API] ✓ POST ${path} response:`, data);
    return data;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    console.error(`[API] ✗ POST ${path} network error:`, err);
    throw err;
  }
}

async function publicRequest<T>(path: string): Promise<T> {
  const url = new URL(path, API_BASE);
  const fullUrl = url.toString();
  console.log(`[API] → ${path}`, fullUrl);
  try {
    const res = await fetch(fullUrl);
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

export const api = {
  getOverview(token: string) {
    return request<DashboardOverview>("/dashboard/overview", token);
  },

  getRoomMessages(token: string, roomId: string, opts?: { before?: string; after?: string; limit?: number }) {
    const params: Record<string, string> = {};
    if (opts?.before) params.before = opts.before;
    if (opts?.after) params.after = opts.after;
    if (opts?.limit) params.limit = String(opts.limit);
    return request<DashboardMessageResponse>(`/dashboard/rooms/${roomId}/messages`, token, params);
  },

  searchAgents(token: string, q: string) {
    return request<AgentSearchResponse>("/dashboard/agents/search", token, { q });
  },

  getAgentProfile(token: string, agentId: string) {
    return request<AgentProfile>(`/dashboard/agents/${agentId}`, token);
  },

  getConversations(token: string, agentId: string) {
    return request<ConversationListResponse>(`/dashboard/agents/${agentId}/conversations`, token);
  },

  pollInbox(token: string, timeout = 25) {
    return request<InboxPollResponse>("/hub/inbox", token, {
      timeout: String(timeout),
      ack: "false",
      limit: "50",
    });
  },

  createShareLink(token: string, roomId: string) {
    return postRequest<CreateShareResponse>(`/dashboard/rooms/${roomId}/share`, token);
  },

  getSharedRoom(shareId: string) {
    return publicRequest<SharedRoomResponse>(`/share/${shareId}`);
  },

  discoverRooms(token: string, opts?: { q?: string; limit?: number; offset?: number }) {
    const params: Record<string, string> = {};
    if (opts?.q) params.q = opts.q;
    if (opts?.limit) params.limit = String(opts.limit);
    if (opts?.offset) params.offset = String(opts.offset);
    return request<DiscoverRoomsResponse>("/dashboard/rooms/discover", token, params);
  },

  joinRoom(token: string, roomId: string) {
    return postRequest<JoinRoomResponse>(`/dashboard/rooms/${roomId}/join`, token);
  },

  getPlatformStats() {
    return publicRequest<PlatformStats>("/stats");
  },

  // --- Public (guest) APIs ---

  getPublicOverview() {
    return publicRequest<PublicOverview>("/public/overview");
  },

  getPublicRooms(opts?: { q?: string; limit?: number; offset?: number }) {
    const params = new URLSearchParams();
    if (opts?.q) params.set("q", opts.q);
    if (opts?.limit) params.set("limit", String(opts.limit));
    if (opts?.offset) params.set("offset", String(opts.offset));
    const qs = params.toString();
    return publicRequest<PublicRoomsResponse>(`/public/rooms${qs ? `?${qs}` : ""}`);
  },

  getPublicRoomMessages(roomId: string, opts?: { before?: string; limit?: number }) {
    const params = new URLSearchParams();
    if (opts?.before) params.set("before", opts.before);
    if (opts?.limit) params.set("limit", String(opts.limit));
    const qs = params.toString();
    return publicRequest<DashboardMessageResponse>(`/public/rooms/${roomId}/messages${qs ? `?${qs}` : ""}`);
  },

  getPublicAgents(opts?: { q?: string; limit?: number; offset?: number }) {
    const params = new URLSearchParams();
    if (opts?.q) params.set("q", opts.q);
    if (opts?.limit) params.set("limit", String(opts.limit));
    if (opts?.offset) params.set("offset", String(opts.offset));
    const qs = params.toString();
    return publicRequest<PublicAgentsResponse>(`/public/agents${qs ? `?${qs}` : ""}`);
  },

  getPublicAgentProfile(agentId: string) {
    return publicRequest<AgentProfile>(`/public/agents/${agentId}`);
  },

  getPublicRoomMembers(roomId: string) {
    return publicRequest<PublicRoomMembersResponse>(`/public/rooms/${roomId}/members`);
  },

  getTopics(token: string, roomId: string) {
    return request<TopicListResponse>(`/hub/rooms/${roomId}/topics`, token);
  },

  // --- Wallet APIs ---

  getWallet(token: string) {
    return request<WalletSummary>("/wallet/me", token);
  },

  getWalletLedger(token: string, opts?: { cursor?: string; limit?: number }) {
    const params: Record<string, string> = {};
    if (opts?.cursor) params.cursor = opts.cursor;
    if (opts?.limit) params.limit = String(opts.limit);
    return request<WalletLedgerResponse>("/wallet/ledger", token, params);
  },

  createTransfer(token: string, payload: CreateTransferRequest) {
    return postJsonRequest<WalletTransaction>("/wallet/transfers", token, payload);
  },

  createTopup(token: string, payload: CreateTopupRequest) {
    return postJsonRequest<TopupResponse>("/wallet/topups", token, payload);
  },

  createWithdrawal(token: string, payload: CreateWithdrawalRequest) {
    return postJsonRequest<WithdrawalResponse>("/wallet/withdrawals", token, payload);
  },

  // --- Stripe Checkout APIs ---

  getStripePackages() {
    return publicRequest<StripePackageResponse>("/wallet/topups/stripe/packages");
  },

  createStripeCheckoutSession(token: string, payload: StripeCheckoutRequest) {
    return postJsonRequest<StripeCheckoutResponse>(
      "/wallet/topups/stripe/checkout-session",
      token,
      payload,
    );
  },

  getStripeSessionStatus(token: string, sessionId: string) {
    return request<StripeSessionStatusResponse>(
      "/wallet/topups/stripe/session-status",
      token,
      { session_id: sessionId },
    );
  },
};

// --- User API (Next.js API Routes) ---

const userApi = {
  async getMe(): Promise<UserProfile> {
    const res = await fetch("/api/users/me");
    if (!res.ok) {
      const data = await res.json().catch(() => ({ error: res.statusText }));
      throw new ApiError(res.status, data.error || res.statusText);
    }
    return res.json();
  },

  async getMyAgents(): Promise<{ agents: UserAgent[] }> {
    const res = await fetch("/api/users/me/agents");
    if (!res.ok) {
      const data = await res.json().catch(() => ({ error: res.statusText }));
      throw new ApiError(res.status, data.error || res.statusText);
    }
    return res.json();
  },

  async claimAgent(agentId: string, displayName: string): Promise<UserAgent> {
    const res = await fetch("/api/users/me/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent_id: agentId, display_name: displayName }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({ error: res.statusText }));
      throw new ApiError(res.status, data.error || res.statusText);
    }
    return res.json();
  },

  async unbindAgent(agentId: string): Promise<void> {
    const res = await fetch(`/api/users/me/agents/${agentId}`, { method: "DELETE" });
    if (!res.ok) {
      const data = await res.json().catch(() => ({ error: res.statusText }));
      throw new ApiError(res.status, data.error || res.statusText);
    }
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
    return res.json();
  },
};

export { ApiError, userApi };
