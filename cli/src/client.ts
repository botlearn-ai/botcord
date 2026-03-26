/**
 * HTTP client for BotCord Hub REST API.
 * Handles JWT token lifecycle and request signing.
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { buildSignedEnvelope, generateKeypair, signChallenge } from "./crypto.js";
import { normalizeAndValidateHubUrl } from "./hub-url.js";
import type {
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
} from "./types.js";

const MAX_RETRIES = 2;
const RETRY_BASE_MS = 1000;

export interface BotCordClientConfig {
  hubUrl: string;
  agentId: string;
  keyId: string;
  privateKey: string;
  token?: string;
  tokenExpiresAt?: number;
}

export class BotCordClient {
  private hubUrl: string;
  private agentId: string;
  private keyId: string;
  private privateKey: string;
  private jwtToken: string | null = null;
  private tokenExpiresAt = 0;

  /** Called after a token refresh so credentials can be persisted. */
  onTokenRefresh?: (token: string, expiresAt: number) => void;

  constructor(config: BotCordClientConfig) {
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

  // ── Token management ──────────────────────────────────────────

  async ensureToken(): Promise<string> {
    if (this.jwtToken && Date.now() / 1000 < this.tokenExpiresAt - 60) {
      return this.jwtToken;
    }
    return this.refreshToken();
  }

  async refreshToken(): Promise<string> {
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
    this.tokenExpiresAt = data.expires_at ?? Date.now() / 1000 + 86400;
    this.onTokenRefresh?.(this.jwtToken, this.tokenExpiresAt);
    return this.jwtToken;
  }

  getToken(): string | null {
    return this.jwtToken;
  }

  getTokenExpiresAt(): number {
    return this.tokenExpiresAt;
  }

  // ── Authenticated fetch with rate-limit retry ─────────────────

  private async hubFetch(path: string, init: RequestInit = {}): Promise<Response> {
    const token = await this.ensureToken();

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
        ...((init.headers as Record<string, string>) ?? {}),
      };
      if (init.body && typeof init.body === "string") {
        headers["Content-Type"] = "application/json";
      }

      const resp = await fetch(`${this.hubUrl}${path}`, {
        ...init,
        headers,
        signal: AbortSignal.timeout(30000),
      });

      if (resp.ok) return resp;

      if (resp.status === 401 && attempt === 0) {
        await this.refreshToken();
        continue;
      }

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
    filePath: string,
    filename: string,
    contentType?: string,
  ): Promise<FileUploadResponse> {
    const fileData = readFileSync(filePath);
    const token = await this.ensureToken();

    const formData = new FormData();
    const blob = new Blob([fileData], { type: contentType || "application/octet-stream" });
    formData.append("file", blob, filename);

    const resp = await fetch(`${this.hubUrl}/hub/upload`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: formData,
      signal: AbortSignal.timeout(30000),
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new Error(`File upload failed: ${resp.status} ${body}`);
    }

    const data = (await resp.json()) as FileUploadResponse;
    if (data.url && !data.url.startsWith("http")) {
      data.url = `${this.hubUrl}${data.url}`;
    }
    return data;
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

    const body: Record<string, unknown> = { ...envelope };
    if (options?.mentions && options.mentions.length > 0) {
      body.mentions = options.mentions;
    }

    const topicQuery = options?.topic ? `?topic=${encodeURIComponent(options.topic)}` : "";
    const resp = await this.hubFetch(`/hub/send${topicQuery}`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    return (await resp.json()) as SendResponse;
  }

  // ── Inbox ─────────────────────────────────────────────────────

  async pollInbox(options?: {
    limit?: number;
    ack?: boolean;
    roomId?: string;
  }): Promise<InboxPollResponse> {
    const params = new URLSearchParams();
    if (options?.limit) params.set("limit", String(options.limit));
    if (options?.ack) params.set("ack", "true");
    if (options?.roomId) params.set("room_id", options.roomId);

    const resp = await this.hubFetch(`/hub/inbox?${params.toString()}`);
    return (await resp.json()) as InboxPollResponse;
  }

  async getHistory(options?: {
    peer?: string;
    roomId?: string;
    topic?: string;
    topicId?: string;
    before?: string;
    after?: string;
    limit?: number;
  }): Promise<unknown> {
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

  async getPolicy(agentId?: string): Promise<{ message_policy: string }> {
    const id = agentId || this.agentId;
    const resp = await this.hubFetch(`/registry/agents/${id}/policy`);
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

  async getMessageStatus(msgId: string): Promise<unknown> {
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
    return ((body as any).contacts ?? body) as ContactInfo[];
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

  async listBlocks(): Promise<unknown[]> {
    const resp = await this.hubFetch(`/registry/agents/${this.agentId}/blocks`);
    return await resp.json() as unknown[];
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
    max_members?: number;
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

  async joinRoom(roomId: string): Promise<void> {
    await this.hubFetch(`/hub/rooms/${roomId}/members`, {
      method: "POST",
      body: JSON.stringify({ agent_id: this.agentId }),
    });
  }

  async leaveRoom(roomId: string): Promise<void> {
    await this.hubFetch(`/hub/rooms/${roomId}/leave`, { method: "POST" });
  }

  async inviteToRoom(roomId: string, agentId: string): Promise<void> {
    await this.hubFetch(`/hub/rooms/${roomId}/members`, {
      method: "POST",
      body: JSON.stringify({ agent_id: agentId }),
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
      visibility?: string;
      join_policy?: string;
      max_members?: number | null;
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
  ): Promise<unknown> {
    const resp = await this.hubFetch(`/hub/rooms/${roomId}/topics`, {
      method: "POST",
      body: JSON.stringify(params),
    });
    return await resp.json();
  }

  async listTopics(roomId: string, status?: string): Promise<unknown[]> {
    const q = status ? `?status=${status}` : "";
    const resp = await this.hubFetch(`/hub/rooms/${roomId}/topics${q}`);
    return await resp.json() as unknown[];
  }

  async getTopic(roomId: string, topicId: string): Promise<unknown> {
    const resp = await this.hubFetch(`/hub/rooms/${roomId}/topics/${topicId}`);
    return await resp.json();
  }

  async updateTopic(
    roomId: string,
    topicId: string,
    params: { title?: string; description?: string; status?: string; goal?: string },
  ): Promise<unknown> {
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
  }): Promise<WalletTransaction> {
    const resp = await this.hubFetch("/wallet/transfers", {
      method: "POST",
      body: JSON.stringify(params),
    });
    return (await resp.json()) as WalletTransaction;
  }

  async createTopup(params: {
    amount_minor: string;
  }): Promise<TopupResponse> {
    const resp = await this.hubFetch("/wallet/topups", {
      method: "POST",
      body: JSON.stringify(params),
    });
    return (await resp.json()) as TopupResponse;
  }

  async createWithdrawal(params: {
    amount_minor: string;
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

  // ── Endpoint registration ─────────────────────────────────────

  async registerEndpoint(url: string, webhookToken: string): Promise<unknown> {
    const resp = await this.hubFetch(`/registry/agents/${this.agentId}/endpoints`, {
      method: "POST",
      body: JSON.stringify({ url, webhook_token: webhookToken }),
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

  // ── Static factory: register a brand-new agent ────────────────

  static async register(
    hubUrl: string,
    name: string,
    bio?: string,
  ): Promise<{
    agentId: string;
    keyId: string;
    privateKey: string;
    publicKey: string;
    token: string;
    expiresAt: number;
    hubUrl: string;
  }> {
    const normalizedHub = normalizeAndValidateHubUrl(hubUrl);
    const keypair = generateKeypair();

    // Step 1: POST /registry/agents
    const regResp = await fetch(`${normalizedHub}/registry/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        display_name: name,
        pubkey: keypair.pubkeyFormatted,
        bio: bio || "",
      }),
      signal: AbortSignal.timeout(10000),
    });

    if (!regResp.ok) {
      const body = await regResp.text().catch(() => "");
      throw new Error(`Agent registration failed: ${regResp.status} ${body}`);
    }

    const regData = (await regResp.json()) as {
      agent_id: string;
      key_id: string;
      challenge: string;
    };

    // Step 2: Sign challenge and verify
    const sig = signChallenge(keypair.privateKey, regData.challenge);

    const verifyResp = await fetch(
      `${normalizedHub}/registry/agents/${regData.agent_id}/verify`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          key_id: regData.key_id,
          challenge: regData.challenge,
          sig,
        }),
        signal: AbortSignal.timeout(10000),
      },
    );

    if (!verifyResp.ok) {
      const body = await verifyResp.text().catch(() => "");
      throw new Error(`Agent verification failed: ${verifyResp.status} ${body}`);
    }

    const verifyData = (await verifyResp.json()) as {
      agent_token: string;
      token?: string;
      expires_at?: number;
    };

    const token = verifyData.agent_token || verifyData.token!;
    const expiresAt = verifyData.expires_at ?? Date.now() / 1000 + 86400;

    return {
      agentId: regData.agent_id,
      keyId: regData.key_id,
      privateKey: keypair.privateKey,
      publicKey: keypair.publicKey,
      token,
      expiresAt,
      hubUrl: normalizedHub,
    };
  }
}
