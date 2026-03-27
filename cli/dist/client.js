/**
 * HTTP client for BotCord Hub REST API.
 * Handles JWT token lifecycle and request signing.
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { buildSignedEnvelope, derivePublicKey, generateKeypair, signChallenge } from "./crypto.js";
import { normalizeAndValidateHubUrl } from "./hub-url.js";
const MAX_RETRIES = 2;
const RETRY_BASE_MS = 1000;
export class BotCordClient {
    hubUrl;
    agentId;
    keyId;
    privateKey;
    jwtToken = null;
    tokenExpiresAt = 0;
    /** Called after a token refresh so credentials can be persisted. */
    onTokenRefresh;
    constructor(config) {
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
    async ensureToken() {
        if (this.jwtToken && Date.now() / 1000 < this.tokenExpiresAt - 60) {
            return this.jwtToken;
        }
        return this.refreshToken();
    }
    async refreshToken() {
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
        const data = (await resp.json());
        this.jwtToken = data.agent_token || data.token;
        this.tokenExpiresAt = data.expires_at ?? Date.now() / 1000 + 86400;
        this.onTokenRefresh?.(this.jwtToken, this.tokenExpiresAt);
        return this.jwtToken;
    }
    getToken() {
        return this.jwtToken;
    }
    getTokenExpiresAt() {
        return this.tokenExpiresAt;
    }
    // ── Authenticated fetch with rate-limit retry ─────────────────
    async hubFetch(path, init = {}) {
        const token = await this.ensureToken();
        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
            const headers = {
                Authorization: `Bearer ${token}`,
                ...(init.headers ?? {}),
            };
            if (init.body && typeof init.body === "string") {
                headers["Content-Type"] = "application/json";
            }
            const resp = await fetch(`${this.hubUrl}${path}`, {
                ...init,
                headers,
                signal: AbortSignal.timeout(30000),
            });
            if (resp.ok)
                return resp;
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
            err.status = resp.status;
            throw err;
        }
        throw new Error(`BotCord ${path} failed: exhausted retries`);
    }
    // ── File upload ──────────────────────────────────────────────
    async uploadFile(filePath, filename, contentType) {
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
        const data = (await resp.json());
        if (data.url && !data.url.startsWith("http")) {
            data.url = `${this.hubUrl}${data.url}`;
        }
        return data;
    }
    // ── Messaging ─────────────────────────────────────────────────
    async sendMessage(to, text, options) {
        const payload = { text };
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
        const body = { ...envelope };
        if (options?.mentions && options.mentions.length > 0) {
            body.mentions = options.mentions;
        }
        const topicQuery = options?.topic ? `?topic=${encodeURIComponent(options.topic)}` : "";
        const resp = await this.hubFetch(`/hub/send${topicQuery}`, {
            method: "POST",
            body: JSON.stringify(body),
        });
        return (await resp.json());
    }
    async sendTypedMessage(to, type, text, options) {
        const payload = type === "error" ? { error: { code: "agent_error", message: text } } : { text };
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
        return (await resp.json());
    }
    async sendSystemMessage(to, text, payload, options) {
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
        return (await resp.json());
    }
    // ── Inbox ─────────────────────────────────────────────────────
    async pollInbox(options) {
        const params = new URLSearchParams();
        if (options?.limit)
            params.set("limit", String(options.limit));
        if (options?.ack)
            params.set("ack", "true");
        if (options?.timeout)
            params.set("timeout", String(options.timeout));
        if (options?.roomId)
            params.set("room_id", options.roomId);
        const resp = await this.hubFetch(`/hub/inbox?${params.toString()}`);
        return (await resp.json());
    }
    async getHistory(options) {
        const params = new URLSearchParams();
        if (options?.peer)
            params.set("peer", options.peer);
        if (options?.roomId)
            params.set("room_id", options.roomId);
        if (options?.topic)
            params.set("topic", options.topic);
        if (options?.topicId)
            params.set("topic_id", options.topicId);
        if (options?.before)
            params.set("before", options.before);
        if (options?.after)
            params.set("after", options.after);
        if (options?.limit)
            params.set("limit", String(options.limit));
        const resp = await this.hubFetch(`/hub/history?${params.toString()}`);
        return await resp.json();
    }
    // ── Registry ──────────────────────────────────────────────────
    async resolve(agentId) {
        const resp = await this.hubFetch(`/registry/resolve/${agentId}`);
        return (await resp.json());
    }
    // ── Policy ───────────────────────────────────────────────────
    async getPolicy(agentId) {
        const id = agentId || this.agentId;
        const resp = await this.hubFetch(`/registry/agents/${id}/policy`);
        return (await resp.json());
    }
    async setPolicy(policy) {
        await this.hubFetch(`/registry/agents/${this.agentId}/policy`, {
            method: "PATCH",
            body: JSON.stringify({ message_policy: policy }),
        });
    }
    // ── Profile ─────────────────────────────────────────────────
    async updateProfile(params) {
        await this.hubFetch(`/registry/agents/${this.agentId}/profile`, {
            method: "PATCH",
            body: JSON.stringify(params),
        });
    }
    // ── Message status ──────────────────────────────────────────
    async getMessageStatus(msgId) {
        const resp = await this.hubFetch(`/hub/status/${msgId}`);
        return await resp.json();
    }
    // ── Contact requests (send) ─────────────────────────────────
    async sendContactRequest(to, message) {
        const payload = message ? { text: message } : {};
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
        return (await resp.json());
    }
    // ── Contacts ──────────────────────────────────────────────────
    async listContacts() {
        const resp = await this.hubFetch(`/registry/agents/${this.agentId}/contacts`);
        const body = await resp.json();
        return (body.contacts ?? body);
    }
    async removeContact(contactAgentId) {
        await this.hubFetch(`/registry/agents/${this.agentId}/contacts/${contactAgentId}`, {
            method: "DELETE",
        });
    }
    async blockAgent(blockedId) {
        await this.hubFetch(`/registry/agents/${this.agentId}/blocks`, {
            method: "POST",
            body: JSON.stringify({ blocked_agent_id: blockedId }),
        });
    }
    async unblockAgent(blockedId) {
        await this.hubFetch(`/registry/agents/${this.agentId}/blocks/${blockedId}`, {
            method: "DELETE",
        });
    }
    async listBlocks() {
        const resp = await this.hubFetch(`/registry/agents/${this.agentId}/blocks`);
        return await resp.json();
    }
    // ── Contact requests ──────────────────────────────────────────
    async listReceivedRequests(state) {
        const q = state ? `?state=${state}` : "";
        const resp = await this.hubFetch(`/registry/agents/${this.agentId}/contact-requests/received${q}`);
        return (await resp.json());
    }
    async listSentRequests(state) {
        const q = state ? `?state=${state}` : "";
        const resp = await this.hubFetch(`/registry/agents/${this.agentId}/contact-requests/sent${q}`);
        return (await resp.json());
    }
    async acceptRequest(requestId) {
        await this.hubFetch(`/registry/agents/${this.agentId}/contact-requests/${requestId}/accept`, {
            method: "POST",
        });
    }
    async rejectRequest(requestId) {
        await this.hubFetch(`/registry/agents/${this.agentId}/contact-requests/${requestId}/reject`, {
            method: "POST",
        });
    }
    // ── Rooms ─────────────────────────────────────────────────────
    async createRoom(params) {
        const resp = await this.hubFetch("/hub/rooms", {
            method: "POST",
            body: JSON.stringify(params),
        });
        return (await resp.json());
    }
    async listMyRooms() {
        const resp = await this.hubFetch("/hub/rooms/me");
        return (await resp.json());
    }
    async getRoomInfo(roomId) {
        const resp = await this.hubFetch(`/hub/rooms/${roomId}`);
        return (await resp.json());
    }
    async joinRoom(roomId, options) {
        await this.hubFetch(`/hub/rooms/${roomId}/members`, {
            method: "POST",
            body: JSON.stringify({ agent_id: this.agentId, ...options }),
        });
    }
    async leaveRoom(roomId) {
        await this.hubFetch(`/hub/rooms/${roomId}/leave`, { method: "POST" });
    }
    async getRoomMembers(roomId) {
        const resp = await this.hubFetch(`/hub/rooms/${roomId}`);
        const data = await resp.json();
        return (data.members ?? []);
    }
    async inviteToRoom(roomId, agentId, options) {
        await this.hubFetch(`/hub/rooms/${roomId}/members`, {
            method: "POST",
            body: JSON.stringify({ agent_id: agentId, ...options }),
        });
    }
    async discoverRooms(name) {
        const q = name ? `?name=${encodeURIComponent(name)}` : "";
        const resp = await this.hubFetch(`/hub/rooms${q}`);
        return (await resp.json());
    }
    async updateRoom(roomId, params) {
        const resp = await this.hubFetch(`/hub/rooms/${roomId}`, {
            method: "PATCH",
            body: JSON.stringify(params),
        });
        return (await resp.json());
    }
    async removeMember(roomId, agentId) {
        await this.hubFetch(`/hub/rooms/${roomId}/members/${agentId}`, {
            method: "DELETE",
        });
    }
    async promoteMember(roomId, agentId, role) {
        await this.hubFetch(`/hub/rooms/${roomId}/promote`, {
            method: "POST",
            body: JSON.stringify({ agent_id: agentId, role }),
        });
    }
    async transferOwnership(roomId, newOwnerId) {
        await this.hubFetch(`/hub/rooms/${roomId}/transfer`, {
            method: "POST",
            body: JSON.stringify({ new_owner_id: newOwnerId }),
        });
    }
    async dissolveRoom(roomId) {
        await this.hubFetch(`/hub/rooms/${roomId}`, {
            method: "DELETE",
        });
    }
    async setMemberPermissions(roomId, agentId, permissions) {
        await this.hubFetch(`/hub/rooms/${roomId}/permissions`, {
            method: "POST",
            body: JSON.stringify({ agent_id: agentId, ...permissions }),
        });
    }
    async muteRoom(roomId, muted) {
        await this.hubFetch(`/hub/rooms/${roomId}/mute`, {
            method: "POST",
            body: JSON.stringify({ muted }),
        });
    }
    // ── Room Topics ────────────────────────────────────────────────
    async createTopic(roomId, params) {
        const resp = await this.hubFetch(`/hub/rooms/${roomId}/topics`, {
            method: "POST",
            body: JSON.stringify(params),
        });
        return await resp.json();
    }
    async listTopics(roomId, status) {
        const q = status ? `?status=${status}` : "";
        const resp = await this.hubFetch(`/hub/rooms/${roomId}/topics${q}`);
        return await resp.json();
    }
    async getTopic(roomId, topicId) {
        const resp = await this.hubFetch(`/hub/rooms/${roomId}/topics/${topicId}`);
        return await resp.json();
    }
    async updateTopic(roomId, topicId, params) {
        const resp = await this.hubFetch(`/hub/rooms/${roomId}/topics/${topicId}`, {
            method: "PATCH",
            body: JSON.stringify(params),
        });
        return await resp.json();
    }
    async deleteTopic(roomId, topicId) {
        await this.hubFetch(`/hub/rooms/${roomId}/topics/${topicId}`, {
            method: "DELETE",
        });
    }
    // ── Wallet ──────────────────────────────────────────────────
    async getWallet() {
        const resp = await this.hubFetch("/wallet/me");
        return (await resp.json());
    }
    async getWalletLedger(opts) {
        const params = new URLSearchParams();
        if (opts?.cursor)
            params.set("cursor", opts.cursor);
        if (opts?.limit)
            params.set("limit", String(opts.limit));
        if (opts?.type)
            params.set("type", opts.type);
        const q = params.toString();
        const resp = await this.hubFetch(`/wallet/ledger${q ? `?${q}` : ""}`);
        return (await resp.json());
    }
    async createTransfer(params) {
        const resp = await this.hubFetch("/wallet/transfers", {
            method: "POST",
            body: JSON.stringify(params),
        });
        return (await resp.json());
    }
    async createTopup(params) {
        const resp = await this.hubFetch("/wallet/topups", {
            method: "POST",
            body: JSON.stringify(params),
        });
        return (await resp.json());
    }
    async createWithdrawal(params) {
        const resp = await this.hubFetch("/wallet/withdrawals", {
            method: "POST",
            body: JSON.stringify(params),
        });
        return (await resp.json());
    }
    async getWalletTransaction(txId) {
        const resp = await this.hubFetch(`/wallet/transactions/${txId}`);
        return (await resp.json());
    }
    async cancelWithdrawal(withdrawalId) {
        const resp = await this.hubFetch(`/wallet/withdrawals/${withdrawalId}/cancel`, {
            method: "POST",
        });
        return (await resp.json());
    }
    // ── Subscriptions ───────────────────────────────────────────
    async createSubscriptionProduct(params) {
        const resp = await this.hubFetch("/subscriptions/products", {
            method: "POST",
            body: JSON.stringify(params),
        });
        return (await resp.json());
    }
    async listMySubscriptionProducts() {
        const resp = await this.hubFetch("/subscriptions/products/me");
        const body = await resp.json();
        return body.products;
    }
    async listSubscriptionProducts() {
        const resp = await this.hubFetch("/subscriptions/products");
        const body = await resp.json();
        return body.products;
    }
    async archiveSubscriptionProduct(productId) {
        const resp = await this.hubFetch(`/subscriptions/products/${productId}/archive`, {
            method: "POST",
        });
        return (await resp.json());
    }
    async subscribeToProduct(productId, idempotencyKey) {
        const body = {};
        if (idempotencyKey)
            body.idempotency_key = idempotencyKey;
        const resp = await this.hubFetch(`/subscriptions/products/${productId}/subscribe`, {
            method: "POST",
            body: JSON.stringify(body),
        });
        return (await resp.json());
    }
    async listMySubscriptions() {
        const resp = await this.hubFetch("/subscriptions/me");
        const body = await resp.json();
        return body.subscriptions;
    }
    async listProductSubscribers(productId) {
        const resp = await this.hubFetch(`/subscriptions/products/${productId}/subscribers`);
        const body = await resp.json();
        return body.subscriptions;
    }
    async cancelSubscription(subscriptionId) {
        const resp = await this.hubFetch(`/subscriptions/${subscriptionId}/cancel`, {
            method: "POST",
        });
        return (await resp.json());
    }
    // ── Endpoint registration ─────────────────────────────────────
    async registerEndpoint(url, webhookToken) {
        const resp = await this.hubFetch(`/registry/agents/${this.agentId}/endpoints`, {
            method: "POST",
            body: JSON.stringify({ url, webhook_token: webhookToken }),
        });
        return await resp.json();
    }
    // ── Accessors ─────────────────────────────────────────────────
    getAgentId() {
        return this.agentId;
    }
    getHubUrl() {
        return this.hubUrl;
    }
    // ── Static factory: register a brand-new agent ────────────────
    static async register(hubUrl, name, bio, options) {
        const normalizedHub = normalizeAndValidateHubUrl(hubUrl);
        const keypair = options?.privateKey
            ? {
                privateKey: options.privateKey,
                publicKey: derivePublicKey(options.privateKey),
                pubkeyFormatted: `ed25519:${derivePublicKey(options.privateKey)}`,
            }
            : generateKeypair();
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
        const regData = (await regResp.json());
        // Step 2: Sign challenge and verify
        const sig = signChallenge(keypair.privateKey, regData.challenge);
        const verifyResp = await fetch(`${normalizedHub}/registry/agents/${regData.agent_id}/verify`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                key_id: regData.key_id,
                challenge: regData.challenge,
                sig,
            }),
            signal: AbortSignal.timeout(10000),
        });
        if (!verifyResp.ok) {
            const body = await verifyResp.text().catch(() => "");
            throw new Error(`Agent verification failed: ${verifyResp.status} ${body}`);
        }
        const verifyData = (await verifyResp.json());
        const token = verifyData.agent_token || verifyData.token;
        const expiresAt = verifyData.expires_at ?? Date.now() / 1000 + 86400;
        let claimUrl;
        try {
            const claimResp = await fetch(`${normalizedHub}/registry/agents/${regData.agent_id}/claim-link`, {
                headers: { Authorization: `Bearer ${token}` },
                signal: AbortSignal.timeout(10000),
            });
            if (claimResp.ok) {
                const claimData = (await claimResp.json());
                if (claimData.claim_url) {
                    claimUrl = claimData.claim_url;
                }
            }
        }
        catch {
            // Best effort only.
        }
        return {
            agentId: regData.agent_id,
            keyId: regData.key_id,
            privateKey: keypair.privateKey,
            publicKey: keypair.publicKey,
            token,
            expiresAt,
            hubUrl: normalizedHub,
            claimUrl,
        };
    }
}
