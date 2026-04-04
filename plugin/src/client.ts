/**
 * HTTP client for BotCord Hub REST API.
 * Handles JWT token lifecycle and request signing.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { buildSignedEnvelope, signChallenge } from "./crypto.js";
import { normalizeAndValidateHubUrl } from "./hub-url.js";
import type {
  BotCordAccountConfig,
  BotCordMessageEnvelope,
  InboxPollResponse,
  SendResponse,
  RoomInfo,
  AgentInfo,
  ContactInfo,
  ContactRequestInfo,
  FileUploadResponse,
  MessageAttachment,
  WalletSummary,
  WalletTransaction,
  WalletLedgerResponse,
  TopupResponse,
  WithdrawalResponse,
  SubscriptionProduct,
  Subscription,
} from "./types.js";

const MAX_RETRIES = 2;
const RETRY_BASE_MS = 1000;

export class BotCordClient {
  private hubUrl: string;
  private agentId: string;
  private keyId: string;
  private privateKey: string;
  private jwtToken: string | null = null;
  private tokenExpiresAt = 0;

  /**
   * Called synchronously after a token refresh so credentials can be persisted.
   * Must be a synchronous function — async persistence should be dispatched
   * internally (e.g. fire-and-forget) by the callback itself.
   */
  onTokenRefresh?: (token: string, expiresAt: number) => void;

  constructor(config: BotCordAccountConfig) {
    if (!config.hubUrl || !config.agentId || !config.keyId || !config.privateKey) {
      throw new Error("BotCord client requires hubUrl, agentId, keyId, and privateKey");
    }
    this.hubUrl = normalizeAndValidateHubUrl(config.hubUrl);
    this.agentId = config.agentId;
    this.keyId = config.keyId;
    this.privateKey = config.privateKey;
    if (config.token) {
      this.jwtToken = config.token;
      this.tokenExpiresAt = config.tokenExpiresAt ?? 0;
    }
  }

  getTokenExpiresAt(): number {
    return this.tokenExpiresAt;
  }

  // ── Token management ──────────────────────────────────────────

  async ensureToken(forceRefresh = false): Promise<string> {
    if (!forceRefresh && this.jwtToken && Date.now() / 1000 < this.tokenExpiresAt - 60) {
      return this.jwtToken;
    }
    return this.refreshToken();
  }

  private async refreshToken(): Promise<string> {
    // POST /registry/agents/{id}/token/refresh with nonce signature
    // Generate a random 32-byte nonce as base64 (matches Hub expectation)
    const nonce = randomBytes(32).toString("base64");
    const sig = signChallenge(this.privateKey, nonce);

    const resp = await fetch(`${this.hubUrl}/registry/agents/${this.agentId}/token/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        key_id: this.keyId,
        nonce,
        sig,
      }),
      signal: AbortSignal.timeout(10000),
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new Error(`Token refresh failed: ${resp.status} ${body}`);
    }

    const data = (await resp.json()) as { agent_token: string; token?: string; expires_at?: number };
    this.jwtToken = data.agent_token || data.token!;
    // Default 24h expiry if not provided
    this.tokenExpiresAt = data.expires_at ?? Date.now() / 1000 + 86400;
    try {
      this.onTokenRefresh?.(this.jwtToken, this.tokenExpiresAt);
    } catch {
      // Token persistence is best-effort — never block the request path
    }
    return this.jwtToken;
  }

  // ── Authenticated fetch with rate-limit retry ─────────────────

  private async hubFetch(path: string, init: RequestInit = {}): Promise<Response> {
    let token = await this.ensureToken();

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
        ...((init.headers as Record<string, string>) ?? {}),
      };
      // Set Content-Type for JSON bodies, but not for FormData (browser/node sets boundary automatically)
      if (init.body && !(init.body instanceof FormData)) {
        headers["Content-Type"] = "application/json";
      }

      const resp = await fetch(`${this.hubUrl}${path}`, {
        ...init,
        headers,
        signal: AbortSignal.timeout(30000),
      });

      if (resp.ok) return resp;

      // Token expired — refresh and retry with the new token
      if (resp.status === 401 && attempt === 0) {
        token = await this.refreshToken();
        continue;
      }

      // Rate limited — retry with backoff
      if (resp.status === 429 && attempt < MAX_RETRIES) {
        const retryAfter = parseInt(resp.headers.get("Retry-After") || "", 10);
        const delayMs = retryAfter > 0 ? retryAfter * 1000 : RETRY_BASE_MS * (attempt + 1);
        await new Promise((r) => setTimeout(r, delayMs));
        continue;
      }

      const body = await resp.text().catch(() => "");
      const err = new Error(`BotCord ${path} failed: ${resp.status} ${body}`);
      (err as any).status = resp.status;
      throw err;
    }
    throw new Error(`BotCord ${path} failed: exhausted retries`);
  }

  // ── File upload ──────────────────────────────────────────────

  async uploadFile(
    file: Buffer | Uint8Array,
    filename: string,
    contentType?: string,
  ): Promise<FileUploadResponse> {
    const formData = new FormData();
    const normalized = Uint8Array.from(file);
    const blob = new Blob([normalized], { type: contentType || "application/octet-stream" });
    formData.append("file", blob, filename);

    const resp = await this.hubFetch("/hub/upload", {
      method: "POST",
      body: formData,
    });
    const data = (await resp.json()) as FileUploadResponse;

    // Server returns a relative URL — make it absolute
    if (data.url && !data.url.startsWith("http")) {
      data.url = `${this.hubUrl}${data.url}`;
    }

    return data;
  }

  // ── Stream blocks (owner-chat WS) ────────────────────────────

  async postStreamBlock(
    traceId: string,
    seq: number,
    block: { kind: string; payload: Record<string, unknown> },
  ): Promise<void> {
    try {
      await this.hubFetch("/hub/stream-block", {
        method: "POST",
        body: JSON.stringify({ trace_id: traceId, seq, block }),
      });
    } catch (err) {
      // Stream blocks are best-effort; log but don't throw
      console.warn(`[botcord] postStreamBlock failed (trace=${traceId} seq=${seq}):`, err);
    }
  }

  async sendTyping(roomId: string): Promise<void> {
    try {
      await this.hubFetch("/hub/typing", {
        method: "POST",
        body: JSON.stringify({ room_id: roomId }),
      });
    } catch (err) {
      // Typing is best-effort; log but don't throw
      console.warn(`[botcord] sendTyping failed (room=${roomId}):`, err);
    }
  }

  // ── Messaging ─────────────────────────────────────────────────

  async sendMessage(
    to: string,
    text: string,
    options?: {
      replyTo?: string;
      topic?: string;
      goal?: string;
      ttlSec?: number;
      attachments?: MessageAttachment[];
      mentions?: string[];
    },
  ): Promise<SendResponse> {
    const payload: Record<string, unknown> = { text };
    if (options?.attachments && options.attachments.length > 0) {
      payload.attachments = options.attachments;
    }

    const envelope = buildSignedEnvelope({
      from: this.agentId,
      to,
      type: "message",
      payload,
      privateKey: this.privateKey,
      keyId: this.keyId,
      replyTo: options?.replyTo,
      ttlSec: options?.ttlSec,
      topic: options?.topic,
      goal: options?.goal,
    });

    // Mentions are not part of the signed envelope — attach after signing
    const body: Record<string, unknown> = { ...envelope };
    if (options?.mentions && options.mentions.length > 0) {
      body.mentions = options.mentions;
    }

    // topic also sent as query param for backward compat with older hubs
    const topicQuery = options?.topic ? `?topic=${encodeURIComponent(options.topic)}` : "";
    const resp = await this.hubFetch(`/hub/send${topicQuery}`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    return (await resp.json()) as SendResponse;
  }

  async sendTypedMessage(
    to: string,
    type: "result" | "error",
    text: string,
    options?: { replyTo?: string; topic?: string; attachments?: MessageAttachment[] },
  ): Promise<SendResponse> {
    const payload: Record<string, unknown> =
      type === "error" ? { error: { code: "agent_error", message: text } } : { text };
    if (options?.attachments && options.attachments.length > 0) {
      payload.attachments = options.attachments;
    }

    const envelope = buildSignedEnvelope({
      from: this.agentId,
      to,
      type,
      payload,
      privateKey: this.privateKey,
      keyId: this.keyId,
      replyTo: options?.replyTo,
      topic: options?.topic,
    });

    const topicQuery = options?.topic ? `?topic=${encodeURIComponent(options.topic)}` : "";
    const resp = await this.hubFetch(`/hub/send${topicQuery}`, {
      method: "POST",
      body: JSON.stringify(envelope),
    });
    return (await resp.json()) as SendResponse;
  }

  async sendSystemMessage(
    to: string,
    text: string,
    payload?: Record<string, unknown>,
    options?: { topic?: string },
  ): Promise<SendResponse> {
    const envelope = buildSignedEnvelope({
      from: this.agentId,
      to,
      type: "system",
      payload: {
        text,
        ...(payload || {}),
      },
      privateKey: this.privateKey,
      keyId: this.keyId,
      topic: options?.topic,
    });
    const topicQuery = options?.topic ? `?topic=${encodeURIComponent(options.topic)}` : "";
    const resp = await this.hubFetch(`/hub/send${topicQuery}`, {
      method: "POST",
      body: JSON.stringify(envelope),
    });
    return (await resp.json()) as SendResponse;
  }

  async sendEnvelope(envelope: BotCordMessageEnvelope, topic?: string): Promise<SendResponse> {
    const topicQuery = topic ? `?topic=${encodeURIComponent(topic)}` : "";
    const resp = await this.hubFetch(`/hub/send${topicQuery}`, {
      method: "POST",
      body: JSON.stringify(envelope),
    });
    return (await resp.json()) as SendResponse;
  }

  // ── Inbox ─────────────────────────────────────────────────────

  async pollInbox(options?: {
    limit?: number;
    ack?: boolean;
    timeout?: number;
    roomId?: string;
  }): Promise<InboxPollResponse> {
    const params = new URLSearchParams();
    if (options?.limit) params.set("limit", String(options.limit));
    if (options?.ack !== undefined) params.set("ack", String(options.ack));
    if (options?.timeout) params.set("timeout", String(options.timeout));
    if (options?.roomId) params.set("room_id", options.roomId);

    const resp = await this.hubFetch(`/hub/inbox?${params.toString()}`);
    return (await resp.json()) as InboxPollResponse;
  }

  async ackMessages(messageIds: string[]): Promise<void> {
    if (messageIds.length === 0) return;
    await this.hubFetch("/hub/inbox/ack", {
      method: "POST",
      body: JSON.stringify({ message_ids: messageIds }),
    });
  }

  async getHistory(options?: {
    peer?: string;
    roomId?: string;
    topic?: string;
    topicId?: string;
    before?: string;
    after?: string;
    limit?: number;
  }): Promise<any> {
    const params = new URLSearchParams();
    if (options?.peer) params.set("peer", options.peer);
    if (options?.roomId) params.set("room_id", options.roomId);
    if (options?.topic) params.set("topic", options.topic);
    if (options?.topicId) params.set("topic_id", options.topicId);
    if (options?.before) params.set("before", options.before);
    if (options?.after) params.set("after", options.after);
    if (options?.limit) params.set("limit", String(options.limit));

    const resp = await this.hubFetch(`/hub/history?${params.toString()}`);
    return await resp.json();
  }

  // ── Registry ──────────────────────────────────────────────────

  async resolve(agentId: string): Promise<AgentInfo> {
    const resp = await this.hubFetch(`/registry/resolve/${agentId}`);
    return (await resp.json()) as AgentInfo;
  }

  // ── Policy ───────────────────────────────────────────────────

  async getPolicy(): Promise<{ message_policy: string }> {
    const resp = await this.hubFetch(`/registry/agents/${this.agentId}/policy`);
    return (await resp.json()) as { message_policy: string };
  }

  async setPolicy(policy: "open" | "contacts_only"): Promise<void> {
    await this.hubFetch(`/registry/agents/${this.agentId}/policy`, {
      method: "PATCH",
      body: JSON.stringify({ message_policy: policy }),
    });
  }

  // ── Profile ─────────────────────────────────────────────────

  async updateProfile(params: { display_name?: string; bio?: string }): Promise<void> {
    await this.hubFetch(`/registry/agents/${this.agentId}/profile`, {
      method: "PATCH",
      body: JSON.stringify(params),
    });
  }

  // ── Message status ──────────────────────────────────────────

  async getMessageStatus(msgId: string): Promise<any> {
    const resp = await this.hubFetch(`/hub/status/${msgId}`);
    return await resp.json();
  }

  // ── Contact requests (send) ─────────────────────────────────

  async sendContactRequest(to: string, message?: string): Promise<SendResponse> {
    const payload: Record<string, unknown> = message ? { text: message } : {};
    const envelope = buildSignedEnvelope({
      from: this.agentId,
      to,
      type: "contact_request",
      payload,
      privateKey: this.privateKey,
      keyId: this.keyId,
    });
    const resp = await this.hubFetch("/hub/send", {
      method: "POST",
      body: JSON.stringify(envelope),
    });
    return (await resp.json()) as SendResponse;
  }

  // ── Contacts ──────────────────────────────────────────────────

  async listContacts(): Promise<ContactInfo[]> {
    const resp = await this.hubFetch(`/registry/agents/${this.agentId}/contacts`);
    const body = await resp.json();
    return (body.contacts ?? body) as ContactInfo[];
  }

  async removeContact(contactAgentId: string): Promise<void> {
    await this.hubFetch(`/registry/agents/${this.agentId}/contacts/${contactAgentId}`, {
      method: "DELETE",
    });
  }

  async blockAgent(blockedId: string): Promise<void> {
    await this.hubFetch(`/registry/agents/${this.agentId}/blocks`, {
      method: "POST",
      body: JSON.stringify({ blocked_agent_id: blockedId }),
    });
  }

  async unblockAgent(blockedId: string): Promise<void> {
    await this.hubFetch(`/registry/agents/${this.agentId}/blocks/${blockedId}`, {
      method: "DELETE",
    });
  }

  async listBlocks(): Promise<any[]> {
    const resp = await this.hubFetch(`/registry/agents/${this.agentId}/blocks`);
    return await resp.json();
  }

  // ── Contact requests ──────────────────────────────────────────

  async listReceivedRequests(state?: string): Promise<ContactRequestInfo[]> {
    const q = state ? `?state=${state}` : "";
    const resp = await this.hubFetch(`/registry/agents/${this.agentId}/contact-requests/received${q}`);
    return (await resp.json()) as ContactRequestInfo[];
  }

  async listSentRequests(state?: string): Promise<ContactRequestInfo[]> {
    const q = state ? `?state=${state}` : "";
    const resp = await this.hubFetch(`/registry/agents/${this.agentId}/contact-requests/sent${q}`);
    return (await resp.json()) as ContactRequestInfo[];
  }

  async acceptRequest(requestId: string): Promise<void> {
    await this.hubFetch(`/registry/agents/${this.agentId}/contact-requests/${requestId}/accept`, {
      method: "POST",
    });
  }

  async rejectRequest(requestId: string): Promise<void> {
    await this.hubFetch(`/registry/agents/${this.agentId}/contact-requests/${requestId}/reject`, {
      method: "POST",
    });
  }

  // ── Rooms ─────────────────────────────────────────────────────

  async createRoom(params: {
    name: string;
    description?: string;
    rule?: string;
    visibility?: "private" | "public";
    join_policy?: "invite_only" | "open";
    required_subscription_product_id?: string;
    max_members?: number;
    default_send?: boolean;
    default_invite?: boolean;
    slow_mode_seconds?: number;
    member_ids?: string[];
  }): Promise<RoomInfo> {
    const resp = await this.hubFetch("/hub/rooms", {
      method: "POST",
      body: JSON.stringify(params),
    });
    return (await resp.json()) as RoomInfo;
  }

  async listMyRooms(): Promise<RoomInfo[]> {
    const resp = await this.hubFetch("/hub/rooms/me");
    return (await resp.json()) as RoomInfo[];
  }

  async getRoomInfo(roomId: string): Promise<RoomInfo> {
    const resp = await this.hubFetch(`/hub/rooms/${roomId}`);
    return (await resp.json()) as RoomInfo;
  }

  async joinRoom(
    roomId: string,
    options?: { can_send?: boolean; can_invite?: boolean },
  ): Promise<void> {
    await this.hubFetch(`/hub/rooms/${roomId}/members`, {
      method: "POST",
      body: JSON.stringify({ agent_id: this.agentId, ...options }),
    });
  }

  async leaveRoom(roomId: string): Promise<void> {
    await this.hubFetch(`/hub/rooms/${roomId}/leave`, { method: "POST" });
  }

  async getRoomMembers(roomId: string): Promise<any[]> {
    const resp = await this.hubFetch(`/hub/rooms/${roomId}`);
    const data = await resp.json();
    return (data as any).members ?? [];
  }

  async inviteToRoom(
    roomId: string,
    agentId: string,
    options?: { can_send?: boolean; can_invite?: boolean },
  ): Promise<void> {
    await this.hubFetch(`/hub/rooms/${roomId}/members`, {
      method: "POST",
      body: JSON.stringify({ agent_id: agentId, ...options }),
    });
  }

  async discoverRooms(name?: string): Promise<RoomInfo[]> {
    const q = name ? `?name=${encodeURIComponent(name)}` : "";
    const resp = await this.hubFetch(`/hub/rooms${q}`);
    return (await resp.json()) as RoomInfo[];
  }

  async updateRoom(
    roomId: string,
    params: {
      name?: string;
      description?: string;
      rule?: string | null;
      visibility?: string;
      join_policy?: string;
      required_subscription_product_id?: string | null;
      max_members?: number | null;
      default_send?: boolean;
      default_invite?: boolean;
      slow_mode_seconds?: number | null;
    },
  ): Promise<RoomInfo> {
    const resp = await this.hubFetch(`/hub/rooms/${roomId}`, {
      method: "PATCH",
      body: JSON.stringify(params),
    });
    return (await resp.json()) as RoomInfo;
  }

  async removeMember(roomId: string, agentId: string): Promise<void> {
    await this.hubFetch(`/hub/rooms/${roomId}/members/${agentId}`, {
      method: "DELETE",
    });
  }

  async promoteMember(roomId: string, agentId: string, role: "admin" | "member"): Promise<void> {
    await this.hubFetch(`/hub/rooms/${roomId}/promote`, {
      method: "POST",
      body: JSON.stringify({ agent_id: agentId, role }),
    });
  }

  async transferOwnership(roomId: string, newOwnerId: string): Promise<void> {
    await this.hubFetch(`/hub/rooms/${roomId}/transfer`, {
      method: "POST",
      body: JSON.stringify({ new_owner_id: newOwnerId }),
    });
  }

  async dissolveRoom(roomId: string): Promise<void> {
    await this.hubFetch(`/hub/rooms/${roomId}`, {
      method: "DELETE",
    });
  }

  async setMemberPermissions(
    roomId: string,
    agentId: string,
    permissions: { can_send?: boolean; can_invite?: boolean },
  ): Promise<void> {
    await this.hubFetch(`/hub/rooms/${roomId}/permissions`, {
      method: "POST",
      body: JSON.stringify({ agent_id: agentId, ...permissions }),
    });
  }

  async muteRoom(roomId: string, muted: boolean): Promise<void> {
    await this.hubFetch(`/hub/rooms/${roomId}/mute`, {
      method: "POST",
      body: JSON.stringify({ muted }),
    });
  }

  // ── Room Topics ────────────────────────────────────────────────

  async createTopic(
    roomId: string,
    params: { title: string; description?: string; goal?: string },
  ): Promise<any> {
    const resp = await this.hubFetch(`/hub/rooms/${roomId}/topics`, {
      method: "POST",
      body: JSON.stringify(params),
    });
    return await resp.json();
  }

  async listTopics(roomId: string, status?: string): Promise<any[]> {
    const q = status ? `?status=${status}` : "";
    const resp = await this.hubFetch(`/hub/rooms/${roomId}/topics${q}`);
    return await resp.json();
  }

  async getTopic(roomId: string, topicId: string): Promise<any> {
    const resp = await this.hubFetch(`/hub/rooms/${roomId}/topics/${topicId}`);
    return await resp.json();
  }

  async updateTopic(
    roomId: string,
    topicId: string,
    params: { title?: string; description?: string; status?: string; goal?: string },
  ): Promise<any> {
    const resp = await this.hubFetch(`/hub/rooms/${roomId}/topics/${topicId}`, {
      method: "PATCH",
      body: JSON.stringify(params),
    });
    return await resp.json();
  }

  async deleteTopic(roomId: string, topicId: string): Promise<void> {
    await this.hubFetch(`/hub/rooms/${roomId}/topics/${topicId}`, {
      method: "DELETE",
    });
  }

  // ── Wallet ──────────────────────────────────────────────────

  async getWallet(): Promise<WalletSummary> {
    const resp = await this.hubFetch("/wallet/me");
    return (await resp.json()) as WalletSummary;
  }

  async getWalletLedger(opts?: {
    cursor?: string;
    limit?: number;
    type?: string;
  }): Promise<WalletLedgerResponse> {
    const params = new URLSearchParams();
    if (opts?.cursor) params.set("cursor", opts.cursor);
    if (opts?.limit) params.set("limit", String(opts.limit));
    if (opts?.type) params.set("type", opts.type);
    const q = params.toString();
    const resp = await this.hubFetch(`/wallet/ledger${q ? `?${q}` : ""}`);
    return (await resp.json()) as WalletLedgerResponse;
  }

  async createTransfer(params: {
    to_agent_id: string;
    amount_minor: string;
    memo?: string;
    reference_type?: string;
    reference_id?: string;
    metadata?: Record<string, unknown>;
    idempotency_key?: string;
  }): Promise<WalletTransaction> {
    const resp = await this.hubFetch("/wallet/transfers", {
      method: "POST",
      body: JSON.stringify(params),
    });
    return (await resp.json()) as WalletTransaction;
  }

  async createTopup(params: {
    amount_minor: string;
    channel?: string;
    metadata?: Record<string, unknown>;
    idempotency_key?: string;
  }): Promise<TopupResponse> {
    const resp = await this.hubFetch("/wallet/topups", {
      method: "POST",
      body: JSON.stringify(params),
    });
    return (await resp.json()) as TopupResponse;
  }

  async createWithdrawal(params: {
    amount_minor: string;
    fee_minor?: string;
    destination_type?: string;
    destination?: Record<string, unknown>;
    idempotency_key?: string;
  }): Promise<WithdrawalResponse> {
    const resp = await this.hubFetch("/wallet/withdrawals", {
      method: "POST",
      body: JSON.stringify(params),
    });
    return (await resp.json()) as WithdrawalResponse;
  }

  async getWalletTransaction(txId: string): Promise<WalletTransaction> {
    const resp = await this.hubFetch(`/wallet/transactions/${txId}`);
    return (await resp.json()) as WalletTransaction;
  }

  async cancelWithdrawal(withdrawalId: string): Promise<WithdrawalResponse> {
    const resp = await this.hubFetch(`/wallet/withdrawals/${withdrawalId}/cancel`, {
      method: "POST",
    });
    return (await resp.json()) as WithdrawalResponse;
  }

  // ── Subscriptions ───────────────────────────────────────────

  async createSubscriptionProduct(params: {
    name: string;
    description?: string;
    amount_minor: string;
    billing_interval: "week" | "month";
    asset_code?: string;
  }): Promise<SubscriptionProduct> {
    const resp = await this.hubFetch("/subscriptions/products", {
      method: "POST",
      body: JSON.stringify(params),
    });
    return (await resp.json()) as SubscriptionProduct;
  }

  async listMySubscriptionProducts(): Promise<SubscriptionProduct[]> {
    const resp = await this.hubFetch("/subscriptions/products/me");
    const body = await resp.json();
    return body.products as SubscriptionProduct[];
  }

  async listSubscriptionProducts(): Promise<SubscriptionProduct[]> {
    const resp = await this.hubFetch("/subscriptions/products");
    const body = await resp.json();
    return body.products as SubscriptionProduct[];
  }

  async archiveSubscriptionProduct(productId: string): Promise<SubscriptionProduct> {
    const resp = await this.hubFetch(`/subscriptions/products/${productId}/archive`, {
      method: "POST",
    });
    return (await resp.json()) as SubscriptionProduct;
  }

  async subscribeToProduct(productId: string, idempotencyKey?: string): Promise<Subscription> {
    const body: Record<string, string> = {};
    if (idempotencyKey) body.idempotency_key = idempotencyKey;
    const resp = await this.hubFetch(`/subscriptions/products/${productId}/subscribe`, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    });
    return (await resp.json()) as Subscription;
  }

  async listMySubscriptions(): Promise<Subscription[]> {
    const resp = await this.hubFetch("/subscriptions/me");
    const body = await resp.json();
    return body.subscriptions as Subscription[];
  }

  async listProductSubscribers(productId: string): Promise<Subscription[]> {
    const resp = await this.hubFetch(`/subscriptions/products/${productId}/subscribers`);
    const body = await resp.json();
    return body.subscriptions as Subscription[];
  }

  async cancelSubscription(subscriptionId: string): Promise<Subscription> {
    const resp = await this.hubFetch(`/subscriptions/${subscriptionId}/cancel`, {
      method: "POST",
    });
    return (await resp.json()) as Subscription;
  }

  // ── Room Context (retrieve / search) ──────────────────────────

  async roomSummary(roomId: string, recentLimit?: number): Promise<any> {
    const params = new URLSearchParams();
    if (recentLimit) params.set("recent_limit", String(recentLimit));
    const q = params.toString();
    const resp = await this.hubFetch(`/hub/rooms/${roomId}/summary${q ? `?${q}` : ""}`);
    return await resp.json();
  }

  async roomMessages(
    roomId: string,
    opts?: {
      limit?: number;
      before?: string;
      after?: string;
      topicId?: string;
      senderId?: string;
    },
  ): Promise<any> {
    const params = new URLSearchParams();
    if (opts?.limit) params.set("limit", String(opts.limit));
    if (opts?.before) params.set("before", opts.before);
    if (opts?.after) params.set("after", opts.after);
    if (opts?.topicId) params.set("topic_id", opts.topicId);
    if (opts?.senderId) params.set("sender_id", opts.senderId);
    const q = params.toString();
    const resp = await this.hubFetch(`/hub/rooms/${roomId}/messages${q ? `?${q}` : ""}`);
    return await resp.json();
  }

  async roomSearch(
    roomId: string,
    query: string,
    opts?: {
      limit?: number;
      before?: string;
      topicId?: string;
      senderId?: string;
    },
  ): Promise<any> {
    const params = new URLSearchParams();
    params.set("q", query);
    if (opts?.limit) params.set("limit", String(opts.limit));
    if (opts?.before) params.set("before", opts.before);
    if (opts?.topicId) params.set("topic_id", opts.topicId);
    if (opts?.senderId) params.set("sender_id", opts.senderId);
    const resp = await this.hubFetch(`/hub/rooms/${roomId}/search?${params.toString()}`);
    return await resp.json();
  }

  async roomsOverview(limit?: number): Promise<any> {
    const params = new URLSearchParams();
    if (limit) params.set("limit", String(limit));
    const q = params.toString();
    const resp = await this.hubFetch(`/hub/rooms/overview${q ? `?${q}` : ""}`);
    return await resp.json();
  }

  async globalSearch(
    query: string,
    opts?: {
      limit?: number;
      roomId?: string;
      topicId?: string;
      senderId?: string;
      before?: string;
    },
  ): Promise<any> {
    const params = new URLSearchParams();
    params.set("q", query);
    if (opts?.limit) params.set("limit", String(opts.limit));
    if (opts?.roomId) params.set("room_id", opts.roomId);
    if (opts?.topicId) params.set("topic_id", opts.topicId);
    if (opts?.senderId) params.set("sender_id", opts.senderId);
    if (opts?.before) params.set("before", opts.before);
    const resp = await this.hubFetch(`/hub/search?${params.toString()}`);
    return await resp.json();
  }

  // ── Invites ──────────────────────────────────────────────────

  async previewInvite(code: string): Promise<any> {
    const resp = await this.hubFetch(`/hub/invites/${encodeURIComponent(code)}`);
    return await resp.json();
  }

  async redeemInvite(code: string): Promise<any> {
    const resp = await this.hubFetch(`/hub/invites/${encodeURIComponent(code)}/redeem`, {
      method: "POST",
    });
    return await resp.json();
  }

  // ── Accessors ─────────────────────────────────────────────────

  getAgentId(): string {
    return this.agentId;
  }

  getHubUrl(): string {
    return this.hubUrl;
  }
}
