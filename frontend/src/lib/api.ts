import type {
  Attachment,
  BindTicketResponse,
  BindTicketStatusResponse,
  FileUploadResult,
  ResetTicketResponse,
  DashboardOverview,
  DashboardRoom,
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
  PublicRoomMessagePreviewResponse,
  PublicAgentsResponse,
  PublicHumanProfile,
  PublicHumansResponse,
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
  SubscriptionProductListResponse,
  MySubscriptionsResponse,
  ProductSubscribersResponse,
  MigrateRoomPlanResponse,
  SubscriptionProduct,
  UserChatRoom,
  UserChatSendResponse,
  RoomHumanSendResponse,
  CreateJoinRequestResponse,
  JoinRequestListResponse,
  MyJoinRequestResponse,
  ActivityStats,
  ActivityFeedResponse,
  RoomResponse,
  UpdateRoomBody,
  HumanInfo,
  HumanAgentRoomListResponse,
  HumanRoomSummary,
  HumanRoomListResponse,
  HumanContactListResponse,
  HumanContactRequestResponse,
  PendingApprovalListResponse,
  ResolveApprovalResponse,
  HumanRoomMemberResponse,
  HumanContactRequestListResponse,
  HumanContactRequestResolveResponse,
  HumanRoomTransferResponse,
  HumanRoomRoleChangeResponse,
  HumanRoomRemoveMemberResponse,
  HumanRoomMuteResponse,
  HumanRoomPermissionsResponse,
} from "./types";

import { createClient } from "@/lib/supabase/client";
import type { AgentPresenceSnapshotPayload } from "@/store/usePresenceStore";
import { DEV_BYPASS_AUTH, mockApiGet, mockApiSend } from "@/lib/dev-bypass";

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
const ACTIVE_IDENTITY_KEY = "botcord_active_identity";
const ME_CACHE_TTL_MS = 10_000;

export type ActiveIdentity =
  | { type: "human"; id: string }
  | { type: "agent"; id: string };

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

export function getStoredActiveIdentity(): ActiveIdentity | null {
  if (typeof window === "undefined") return null;
  const raw = localStorage.getItem(ACTIVE_IDENTITY_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed &&
      typeof parsed === "object" &&
      (parsed as { type?: unknown }).type &&
      typeof (parsed as { id?: unknown }).id === "string"
    ) {
      const t = (parsed as { type: string }).type;
      const id = (parsed as { id: string }).id;
      if ((t === "human" || t === "agent") && id) {
        return { type: t, id };
      }
    }
  } catch {
    // fall through
  }
  return null;
}

export function setStoredActiveIdentity(identity: ActiveIdentity | null) {
  if (typeof window === "undefined") return;
  if (identity) {
    localStorage.setItem(ACTIVE_IDENTITY_KEY, JSON.stringify(identity));
  } else {
    localStorage.removeItem(ACTIVE_IDENTITY_KEY);
  }
}

/**
 * Resolve the effective active identity, tolerating stores from older sessions
 * that only wrote `botcord_active_agent_id`. Returns null when neither exists.
 */
export function getActiveIdentity(): ActiveIdentity | null {
  const stored = getStoredActiveIdentity();
  if (stored) return stored;
  const legacyAgent = getActiveAgentId();
  return legacyAgent ? { type: "agent", id: legacyAgent } : null;
}

function extractErrorMessage(body: Record<string, unknown>, fallback: string): string {
  if (typeof body.error === "string") return body.error;
  const detail = body.detail;
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) {
    return detail.map((d: { msg?: string }) => d.msg ?? JSON.stringify(d)).join("; ");
  }
  return fallback;
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

async function buildAuthHeaders(identityOverride?: ActiveIdentity | null): Promise<Record<string, string>> {
  const headers: Record<string, string> = {};
  const token = await getAccessToken();
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  // New identity model: only send X-Active-Agent when acting as an agent.
  // For type='human', the backend resolves human_id from the Supabase JWT.
  // `identityOverride` lets per-call code (e.g. wallet viewer switcher)
  // address a different owned identity without mutating global session state.
  // ``null`` and ``undefined`` both mean "no override — follow global active
  // identity"; only a concrete ``ActiveIdentity`` overrides. The wallet
  // store passes ``walletViewer`` (default ``null``) on every call and
  // depends on this fallback to send X-Active-Agent for the global agent.
  const identity = identityOverride ?? getActiveIdentity();
  if (identity?.type === "agent") {
    headers["X-Active-Agent"] = identity.id;
  }
  return headers;
}

/**
 * Pick the `?as=agent|human` query value for wallet APIs based on a
 * (possibly overridden) identity. Backend `_resolve_owner` uses this to
 * choose between `ctx.active_agent_id` (requires X-Active-Agent) and
 * `ctx.human_id` (resolved from Supabase JWT). ``null``/``undefined``
 * fall back to the global active identity (matching ``buildAuthHeaders``).
 */
function walletAsParam(identityOverride?: ActiveIdentity | null): "agent" | "human" {
  const id = identityOverride ?? getActiveIdentity();
  return id?.type === "human" ? "human" : "agent";
}

// --- Core request helpers ---

async function apiGet<T>(
  path: string,
  params?: Record<string, string>,
  identityOverride?: ActiveIdentity | null,
): Promise<T> {
  if (DEV_BYPASS_AUTH) return mockApiGet<T>(path, params);
  const url = new URL(path, API_BASE);
  if (params) {
    Object.entries(params).forEach(([k, v]) => {
      if (v !== undefined && v !== null) url.searchParams.set(k, v);
    });
  }
  const headers = await buildAuthHeaders(identityOverride);
  const res = await fetch(url.toString(), { headers });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new ApiError(res.status, extractErrorMessage(body, res.statusText));
  }
  return res.json();
}

async function apiPost<T>(
  path: string,
  body?: unknown,
  identityOverride?: ActiveIdentity | null,
): Promise<T> {
  if (DEV_BYPASS_AUTH) return mockApiSend<T>("POST", path, body);
  const headers: Record<string, string> = { ...(await buildAuthHeaders(identityOverride)) };
  const init: RequestInit = { method: "POST", headers };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const url = new URL(path, API_BASE);
  const res = await fetch(url.toString(), init);
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: res.statusText }));
    throw new ApiError(res.status, extractErrorMessage(data, res.statusText));
  }
  return res.json();
}

async function apiPatch<T>(path: string, body?: unknown): Promise<T> {
  if (DEV_BYPASS_AUTH) return mockApiSend<T>("PATCH", path, body);
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
    throw new ApiError(res.status, extractErrorMessage(data, res.statusText));
  }
  return res.json();
}

async function apiDelete<T>(path: string): Promise<T> {
  if (DEV_BYPASS_AUTH) return mockApiSend<T>("DELETE", path);
  const headers = await buildAuthHeaders();
  const url = new URL(path, API_BASE);
  const res = await fetch(url.toString(), { method: "DELETE", headers });
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: res.statusText }));
    throw new ApiError(res.status, extractErrorMessage(data, res.statusText));
  }
  if (res.status === 204) return undefined as T;
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

  async searchAgentDirectory(q: string): Promise<AgentProfile[]> {
    const token = await getAccessToken();
    if (token) {
      const result = await api.searchAgents(q);
      return result.agents;
    }
    const result = await api.getPublicAgents({ q });
    return result.agents;
  },

  async getAgentCard(agentId: string): Promise<{
    profile: AgentProfile;
    conversations: DashboardRoom[] | null;
  }> {
    const token = await getAccessToken();
    if (token) {
      const [profile, convos] = await Promise.all([
        api.getAgentProfile(agentId),
        api.getConversations(agentId),
      ]);
      return {
        profile,
        conversations: convos.conversations,
      };
    }

    const profile = await api.getPublicAgentProfile(agentId);
    return {
      profile,
      conversations: null,
    };
  },

  createShareLink(roomId: string) {
    return apiPost<CreateShareResponse>(`/api/dashboard/rooms/${roomId}/share`);
  },

  updateRoomSettings(
    roomId: string,
    patch: {
      name?: string;
      description?: string;
      rule?: string | null;
      visibility?: "public" | "private";
      join_policy?: "open" | "invite_only";
      default_send?: boolean;
      default_invite?: boolean;
      allow_human_send?: boolean;
      max_members?: number | null;
      slow_mode_seconds?: number | null;
      required_subscription_product_id?: string | null;
    },
  ) {
    return apiPatch<{
      room_id: string;
      name: string;
      description: string | null;
      rule: string | null;
      visibility?: string;
      join_policy?: string;
      default_send?: boolean;
      default_invite?: boolean;
      allow_human_send?: boolean;
      max_members?: number | null;
      slow_mode_seconds?: number | null;
      required_subscription_product_id?: string | null;
    }>(`/api/dashboard/rooms/${roomId}`, patch);
  },

  dissolveRoom(roomId: string) {
    return apiDelete<{ ok: boolean }>(`/api/dashboard/rooms/${roomId}`);
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

  updateRoom(roomId: string, patch: UpdateRoomBody) {
    return apiPatch<RoomResponse>(`/api/dashboard/rooms/${roomId}`, patch);
  },

  leaveRoom(roomId: string) {
    return apiPost<LeaveRoomResponse>(`/api/dashboard/rooms/${roomId}/leave`);
  },

  removeContact(contactAgentId: string) {
    return apiDelete<void>(`/api/dashboard/contacts/${contactAgentId}`);
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

  // --- Presence ---

  getPresenceSnapshots(agentIds: string[]) {
    return apiPost<{ agents: AgentPresenceSnapshotPayload[] }>(
      "/api/presence/agents/snapshot",
      { agent_ids: agentIds },
    );
  },

  setManualStatus(
    agentId: string,
    body: {
      manual_status: "available" | "busy" | "away" | "invisible";
      status_message?: string | null;
      manual_expires_at?: string | null;
    },
  ) {
    return apiPatch<AgentPresenceSnapshotPayload>(
      `/api/agents/${agentId}/status`,
      body,
    );
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

  getPublicRoomMessagePreviews(roomId: string) {
    return apiGet<PublicRoomMessagePreviewResponse>(`/api/public/rooms/${roomId}/message-previews`);
  },

  getPublicAgents(opts?: { q?: string; limit?: number; offset?: number }) {
    const params: Record<string, string> = {};
    if (opts?.q) params.q = opts.q;
    if (opts?.limit) params.limit = String(opts.limit);
    if (opts?.offset) params.offset = String(opts.offset);
    return apiGet<PublicAgentsResponse>("/api/public/agents", params);
  },

  getPublicHumans(opts?: { q?: string; limit?: number; offset?: number }) {
    const params: Record<string, string> = {};
    if (opts?.q) params.q = opts.q;
    if (opts?.limit) params.limit = String(opts.limit);
    if (opts?.offset) params.offset = String(opts.offset);
    return apiGet<PublicHumansResponse>("/api/public/humans", params);
  },

  getPublicHuman(humanId: string) {
    return apiGet<PublicHumanProfile>(`/api/public/humans/${humanId}`);
  },

  getPublicAgentProfile(agentId: string) {
    return apiGet<AgentProfile>(`/api/public/agents/${agentId}`);
  },

  getPublicRoomMembers(roomId: string) {
    return apiGet<PublicRoomMembersResponse>(`/api/public/rooms/${roomId}/members`);
  },

  getRoomMembers(roomId: string) {
    return apiGet<PublicRoomMembersResponse>(`/api/dashboard/rooms/${roomId}/members`);
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

  createContactRequest(
    payload:
      | { to_agent_id: string; to_human_id?: undefined; message?: string }
      | { to_human_id: string; to_agent_id?: undefined; message?: string },
  ) {
    // Runtime guard: exactly one of to_agent_id / to_human_id must be set.
    const hasAgent = Boolean(
      (payload as { to_agent_id?: string }).to_agent_id,
    );
    const hasHuman = Boolean(
      (payload as { to_human_id?: string }).to_human_id,
    );
    if (hasAgent === hasHuman) {
      throw new Error(
        "createContactRequest: provide exactly one of to_agent_id or to_human_id",
      );
    }
    return apiPost<ContactRequestItem>("/api/dashboard/contact-requests", payload);
  },

  acceptContactRequest(requestId: number) {
    return apiPost<ContactRequestItem>(`/api/dashboard/contact-requests/${requestId}/accept`);
  },

  rejectContactRequest(requestId: number) {
    return apiPost<ContactRequestItem>(`/api/dashboard/contact-requests/${requestId}/reject`);
  },

  // --- Wallet APIs ---
  //
  // All wallet methods accept an optional ``viewer`` (ActiveIdentity) so the
  // wallet UI can switch between the user's owned identities (their human +
  // owned bots) without mutating global session state. When omitted, the
  // backend resolves the owner from the global active identity.

  getWallet(viewer?: ActiveIdentity | null) {
    return apiGet<WalletSummary>(
      "/api/wallet/summary",
      { as: walletAsParam(viewer) },
      viewer,
    );
  },

  getWalletLedger(opts?: { cursor?: string; limit?: number; viewer?: ActiveIdentity | null }) {
    const params: Record<string, string> = { as: walletAsParam(opts?.viewer) };
    if (opts?.cursor) params.cursor = opts.cursor;
    if (opts?.limit) params.limit = String(opts.limit);
    return apiGet<WalletLedgerResponse>("/api/wallet/ledger", params, opts?.viewer);
  },

  createTransfer(payload: CreateTransferRequest, viewer?: ActiveIdentity | null) {
    return apiPost<WalletTransaction>(
      `/api/wallet/transfers?as=${walletAsParam(viewer)}`,
      payload,
      viewer,
    );
  },

  createTopup(payload: CreateTopupRequest, viewer?: ActiveIdentity | null) {
    return apiPost<TopupResponse>(
      `/api/wallet/topups?as=${walletAsParam(viewer)}`,
      payload,
      viewer,
    );
  },

  createWithdrawal(payload: CreateWithdrawalRequest, viewer?: ActiveIdentity | null) {
    return apiPost<WithdrawalResponse>(
      `/api/wallet/withdrawals?as=${walletAsParam(viewer)}`,
      payload,
      viewer,
    );
  },

  getWithdrawals(viewer?: ActiveIdentity | null) {
    return apiGet<WithdrawalListResponse>(
      "/api/wallet/withdrawals",
      { as: walletAsParam(viewer) },
      viewer,
    );
  },

  cancelWithdrawal(withdrawalId: string, viewer?: ActiveIdentity | null) {
    return apiPost<{ withdrawal_id: string; status: string }>(
      `/api/wallet/withdrawals/${withdrawalId}/cancel?as=${walletAsParam(viewer)}`,
      undefined,
      viewer,
    );
  },

  // --- Stripe Checkout APIs ---

  getStripePackages() {
    return apiGet<StripePackageResponse>("/api/wallet/stripe/packages");
  },

  createStripeCheckoutSession(payload: StripeCheckoutRequest, viewer?: ActiveIdentity | null) {
    return apiPost<StripeCheckoutResponse>(
      `/api/wallet/stripe/checkout-session?as=${walletAsParam(viewer)}`,
      payload,
      viewer,
    );
  },

  getStripeSessionStatus(sessionId: string, viewer?: ActiveIdentity | null) {
    return apiGet<StripeSessionStatusResponse>(
      "/api/wallet/stripe/session-status",
      {
        session_id: sessionId,
        as: walletAsParam(viewer),
      },
      viewer,
    );
  },

  // --- Subscriptions ---
  getSubscriptionProduct(productId: string) {
    return apiGet<SubscriptionProductResponse>(`/api/subscriptions/products/${productId}`);
  },
  getMySubscriptionProducts() {
    return apiGet<SubscriptionProductListResponse>("/api/subscriptions/products/me");
  },
  subscribeToProduct(productId: string, opts?: { roomId?: string }) {
    const body: Record<string, unknown> = {};
    if (opts?.roomId) body.room_id = opts.roomId;
    return apiPost<any>(`/api/subscriptions/products/${productId}/subscribe`, body);
  },
  cancelSubscription(subscriptionId: string) {
    return apiPost<{ subscription_id: string; status: string }>(`/api/subscriptions/${subscriptionId}/cancel`);
  },
  getMySubscriptions() {
    return apiGet<MySubscriptionsResponse>("/api/subscriptions/me");
  },
  createSubscriptionProduct(body: {
    name: string;
    amount_minor: string;
    billing_interval: "week" | "month";
    description?: string;
  }) {
    return apiPost<SubscriptionProduct>("/api/subscriptions/products", body);
  },
  archiveSubscriptionProduct(productId: string) {
    return apiPost<SubscriptionProduct>(
      `/api/subscriptions/products/${productId}/archive`,
    );
  },
  listProductSubscribers(productId: string, opts?: { status?: string }) {
    return apiGet<ProductSubscribersResponse>(
      `/api/subscriptions/products/${productId}/subscribers`,
      opts?.status ? { status: opts.status } : undefined,
    );
  },
  migrateRoomSubscriptionPlan(
    roomId: string,
    body: {
      amount_minor: string;
      billing_interval: "week" | "month";
      description?: string;
      // Required when the target room is human-owned. Ignored otherwise.
      provider_agent_id?: string;
    },
  ) {
    return apiPost<MigrateRoomPlanResponse>(
      `/api/dashboard/rooms/${roomId}/subscription/migrate-plan`,
      body,
    );
  },

  // --- User Chat (owner-agent direct messaging) ---

  getUserChatRoom(agentId?: string | null) {
    return apiGet<UserChatRoom>(
      "/api/dashboard/chat/room",
      agentId ? { agent_id: agentId } : undefined,
    );
  },

  sendUserChatMessage(text: string, attachments?: Attachment[], agentId?: string | null) {
    const body: Record<string, unknown> = { text };
    if (agentId) {
      body.agent_id = agentId;
    }
    if (attachments && attachments.length > 0) {
      body.attachments = attachments;
    }
    return apiPost<UserChatSendResponse>("/api/dashboard/chat/send", body);
  },

  sendRoomHumanMessage(roomId: string, text: string, mentions?: string[], topicId?: string | null) {
    const body: Record<string, unknown> = { text };
    if (mentions && mentions.length > 0) body.mentions = mentions;
    if (topicId) body.topic_id = topicId;
    return apiPost<RoomHumanSendResponse>(`/api/dashboard/rooms/${roomId}/send`, body);
  },

  openDmRoom(peerId: string) {
    return apiPost<{ room_id: string }>("/api/dashboard/dms/open", { peer_id: peerId });
  },

  async uploadFile(file: File, agentId?: string | null): Promise<FileUploadResult> {
    const headers = await buildAuthHeaders();
    const formData = new FormData();
    formData.append("file", file);
    const url = new URL("/api/dashboard/upload", API_BASE);
    if (agentId) {
      url.searchParams.set("agent_id", agentId);
    }
    const res = await fetch(url.toString(), {
      method: "POST",
      headers,
      body: formData,
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({ error: res.statusText }));
      throw new ApiError(res.status, extractErrorMessage(data, res.statusText));
    }
    return res.json();
  },

  // --- Activity / Observability ---

  getActivityStats(period: "today" | "7d" | "30d" = "today") {
    return apiGet<ActivityStats>("/api/dashboard/activity/stats", { period });
  },

  getActivityFeed(opts?: { period?: string; limit?: number; offset?: number }) {
    const params: Record<string, string> = {};
    if (opts?.period) params.period = opts.period;
    if (opts?.limit) params.limit = String(opts.limit);
    if (opts?.offset) params.offset = String(opts.offset);
    return apiGet<ActivityFeedResponse>("/api/dashboard/activity/feed", params);
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

  async issueBindTicket(opts?: { intendedName?: string | null }): Promise<BindTicketResponse> {
    const body: Record<string, unknown> = {};
    if (opts?.intendedName) body.intended_name = opts.intendedName;
    return apiPost<BindTicketResponse>("/api/users/me/agents/bind-ticket", body);
  },

  async getBindTicketStatus(code: string): Promise<BindTicketStatusResponse> {
    return apiGet<BindTicketStatusResponse>(
      `/api/users/me/agents/bind-ticket/${encodeURIComponent(code)}`,
    );
  },

  async revokeBindTicket(code: string): Promise<{ ok: boolean }> {
    return apiDelete<{ ok: boolean }>(
      `/api/users/me/agents/bind-ticket/${encodeURIComponent(code)}`,
    );
  },

  async issueCredentialResetTicket(agentId: string): Promise<ResetTicketResponse> {
    return apiPost<ResetTicketResponse>(`/api/users/me/agents/${agentId}/credential-reset-ticket`);
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

  getAgentIdentity(agentId: string): Promise<{ agent_id: string; agent_token: string | null }> {
    return apiGet<{ agent_id: string; agent_token: string | null }>(`/api/users/me/agents/${agentId}/identity`);
  },

  async updateAgent(
    agentId: string,
    patch: { display_name?: string; bio?: string | null; is_default?: boolean },
  ): Promise<{
    agent_id: string;
    display_name: string;
    bio: string | null;
    is_default: boolean;
    claimed_at: string | null;
  }> {
    const result = await apiPatch<{
      agent_id: string;
      display_name: string;
      bio: string | null;
      is_default: boolean;
      claimed_at: string | null;
    }>(`/api/users/me/agents/${agentId}`, patch);
    invalidateMeCache();
    return result;
  },

  async unbindAgent(agentId: string): Promise<{ ok: boolean }> {
    const result = await apiDelete<{ ok: boolean }>(`/api/users/me/agents/${agentId}`);
    invalidateMeCache();
    if (getActiveAgentId() === agentId) {
      setActiveAgentId(null);
    }
    return result;
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

// ---------------------------------------------------------------------------
// Human-as-first-class BFF (backend: app/routers/humans.py)
// ---------------------------------------------------------------------------

const humansApi = {
  /** Idempotently ensure a Human identity exists for the authed user. */
  async createOrGet(): Promise<HumanInfo> {
    return apiPost<HumanInfo>("/api/humans/me");
  },

  getMe(): Promise<HumanInfo> {
    return apiGet<HumanInfo>("/api/humans/me");
  },

  async updateProfile(
    patch: { display_name?: string; avatar_url?: string | null },
  ): Promise<HumanInfo> {
    return apiPatch<HumanInfo>("/api/humans/me", patch);
  },

  listRooms(): Promise<HumanRoomListResponse> {
    return apiGet<HumanRoomListResponse>("/api/humans/me/rooms");
  },

  listAgentRooms(): Promise<HumanAgentRoomListResponse> {
    return apiGet<HumanAgentRoomListResponse>("/api/humans/me/agent-rooms");
  },

  /** Human self-joins a public+open room. */
  async joinRoom(roomId: string): Promise<HumanRoomSummary> {
    return apiPost<HumanRoomSummary>(`/api/humans/me/rooms/${roomId}/join`);
  },

  async createRoom(body: {
    name: string;
    description?: string;
    rule?: string | null;
    visibility?: "public" | "private";
    join_policy?: "open" | "invite_only";
    default_send?: boolean;
    default_invite?: boolean;
    max_members?: number | null;
    slow_mode_seconds?: number | null;
    member_ids?: string[];
  }): Promise<HumanRoomSummary> {
    return apiPost<HumanRoomSummary>("/api/humans/me/rooms", body);
  },

  async updateRoomSettings(
    roomId: string,
    patch: {
      name?: string;
      description?: string;
      rule?: string | null;
      visibility?: "public" | "private";
      join_policy?: "open" | "invite_only";
      default_send?: boolean;
      default_invite?: boolean;
      allow_human_send?: boolean;
      max_members?: number | null;
      slow_mode_seconds?: number | null;
      required_subscription_product_id?: string | null;
    },
  ): Promise<HumanRoomSummary> {
    return apiPatch<HumanRoomSummary>(`/api/humans/me/rooms/${roomId}`, patch);
  },

  dissolveRoom(roomId: string): Promise<{ ok: boolean }> {
    return apiDelete<{ ok: boolean }>(`/api/humans/me/rooms/${roomId}`);
  },

  listContacts(): Promise<HumanContactListResponse> {
    return apiGet<HumanContactListResponse>("/api/humans/me/contacts");
  },

  async sendContactRequest(body: {
    peer_id: string;
    message?: string;
  }): Promise<HumanContactRequestResponse> {
    return apiPost<HumanContactRequestResponse>(
      "/api/humans/me/contacts/request",
      body,
    );
  },

  listPendingApprovals(): Promise<PendingApprovalListResponse> {
    return apiGet<PendingApprovalListResponse>("/api/humans/me/pending-approvals");
  },

  async resolvePendingApproval(
    approvalId: string,
    decision: "approve" | "reject",
  ): Promise<ResolveApprovalResponse> {
    return apiPost<ResolveApprovalResponse>(
      `/api/humans/me/pending-approvals/${approvalId}/resolve`,
      { decision },
    );
  },

  // -------------------------------------------------------------------------
  // New Human-surface endpoints (paired with backend work in progress).
  // -------------------------------------------------------------------------

  /** Human (owner/admin) invites an agent or another Human into a room. */
  async addRoomMember(
    roomId: string,
    body: { participant_id: string; role?: "member" | "admin" },
  ): Promise<HumanRoomMemberResponse> {
    return apiPost<HumanRoomMemberResponse>(
      `/api/humans/me/rooms/${roomId}/members`,
      body,
    );
  },

  /** Human creates a friend invite link. */
  createFriendInvite(): Promise<InvitePreviewResponse> {
    return apiPost<InvitePreviewResponse>("/api/humans/me/invite");
  },

  /** Human creates a private-room invite link. */
  createRoomInvite(roomId: string): Promise<InvitePreviewResponse> {
    return apiPost<InvitePreviewResponse>(`/api/humans/me/rooms/${roomId}/invite`);
  },

  /** Human creates a public-room share snapshot. */
  createShareLink(roomId: string): Promise<CreateShareResponse> {
    return apiPost<CreateShareResponse>(`/api/humans/me/rooms/${roomId}/share`);
  },

  /** Received contact requests (pending-by-default). */
  listReceivedContactRequests(
    opts?: { state?: "pending" | "accepted" | "rejected" },
  ): Promise<HumanContactRequestListResponse> {
    const params: Record<string, string> = {};
    if (opts?.state) params.state = opts.state;
    return apiGet<HumanContactRequestListResponse>(
      "/api/humans/me/contact-requests/received",
      params,
    );
  },

  /** Sent contact requests (pending-by-default). */
  listSentContactRequests(
    opts?: { state?: "pending" | "accepted" | "rejected" },
  ): Promise<HumanContactRequestListResponse> {
    const params: Record<string, string> = {};
    if (opts?.state) params.state = opts.state;
    return apiGet<HumanContactRequestListResponse>(
      "/api/humans/me/contact-requests/sent",
      params,
    );
  },

  /** Accept a received contact request addressed to the current Human. */
  acceptContactRequest(
    requestId: string,
  ): Promise<HumanContactRequestResolveResponse> {
    return apiPost<HumanContactRequestResolveResponse>(
      `/api/humans/me/contact-requests/${requestId}/accept`,
    );
  },

  /** Reject a received contact request addressed to the current Human. */
  rejectContactRequest(
    requestId: string,
  ): Promise<HumanContactRequestResolveResponse> {
    return apiPost<HumanContactRequestResolveResponse>(
      `/api/humans/me/contact-requests/${requestId}/reject`,
    );
  },

  // -------------------------------------------------------------------------
  // Phase 4 — Human moderator actions on a room. Caller must be a Human
  // owner/admin of the target room. All accept polymorphic participant ids
  // (``ag_*`` or ``hu_*``). Writes do NOT send the ``X-Active-Agent`` header;
  // the backend treats the authenticated Human as the moderator.
  // -------------------------------------------------------------------------

  /** Transfer room ownership to another member. Owner only. */
  transferRoomOwnership(
    roomId: string,
    newOwnerId: string,
  ): Promise<HumanRoomTransferResponse> {
    return apiPost<HumanRoomTransferResponse>(
      `/api/humans/me/rooms/${roomId}/transfer`,
      { new_owner_id: newOwnerId },
    );
  },

  /** Promote/demote a member between admin and member. Owner only. */
  promoteRoomMember(
    roomId: string,
    participantId: string,
    role: "admin" | "member",
  ): Promise<HumanRoomRoleChangeResponse> {
    return apiPost<HumanRoomRoleChangeResponse>(
      `/api/humans/me/rooms/${roomId}/promote`,
      { participant_id: participantId, role },
    );
  },

  /** Remove a member. Owner/admin only; owner cannot be removed. */
  removeRoomMember(
    roomId: string,
    participantId: string,
  ): Promise<HumanRoomRemoveMemberResponse> {
    return apiDelete<HumanRoomRemoveMemberResponse>(
      `/api/humans/me/rooms/${roomId}/members/${participantId}`,
    );
  },

  /** Toggle mute for the caller's own Human membership. */
  setRoomMute(roomId: string, muted: boolean): Promise<HumanRoomMuteResponse> {
    return apiPost<HumanRoomMuteResponse>(
      `/api/humans/me/rooms/${roomId}/mute`,
      { muted },
    );
  },

  /** Set per-member permission overrides. Owner/admin only. */
  setRoomMemberPermissions(
    roomId: string,
    participantId: string,
    body: { can_send?: boolean | null; can_invite?: boolean | null },
  ): Promise<HumanRoomPermissionsResponse> {
    return apiPost<HumanRoomPermissionsResponse>(
      `/api/humans/me/rooms/${roomId}/permissions`,
      { participant_id: participantId, ...body },
    );
  },
};

export { ApiError, userApi, betaApi, adminBetaApi, humansApi };
