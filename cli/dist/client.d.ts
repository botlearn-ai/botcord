import type { InboxPollResponse, SendResponse, RoomInfo, AgentInfo, ContactInfo, ContactRequestInfo, FileUploadResponse, MessageAttachment, WalletSummary, WalletTransaction, WalletLedgerResponse, TopupResponse, WithdrawalResponse, SubscriptionProduct, Subscription } from "./types.js";
export interface BotCordClientConfig {
    hubUrl: string;
    agentId: string;
    keyId: string;
    privateKey: string;
    token?: string;
    tokenExpiresAt?: number;
}
export declare class BotCordClient {
    private hubUrl;
    private agentId;
    private keyId;
    private privateKey;
    private jwtToken;
    private tokenExpiresAt;
    /** Called after a token refresh so credentials can be persisted. */
    onTokenRefresh?: (token: string, expiresAt: number) => void;
    constructor(config: BotCordClientConfig);
    ensureToken(): Promise<string>;
    refreshToken(): Promise<string>;
    getToken(): string | null;
    getTokenExpiresAt(): number;
    private hubFetch;
    uploadFile(filePath: string, filename: string, contentType?: string): Promise<FileUploadResponse>;
    sendMessage(to: string, text: string, options?: {
        replyTo?: string;
        topic?: string;
        goal?: string;
        ttlSec?: number;
        attachments?: MessageAttachment[];
        mentions?: string[];
    }): Promise<SendResponse>;
    sendTypedMessage(to: string, type: "result" | "error", text: string, options?: {
        replyTo?: string;
        topic?: string;
        attachments?: MessageAttachment[];
    }): Promise<SendResponse>;
    sendSystemMessage(to: string, text: string, payload?: Record<string, unknown>, options?: {
        topic?: string;
    }): Promise<SendResponse>;
    pollInbox(options?: {
        limit?: number;
        ack?: boolean;
        timeout?: number;
        roomId?: string;
    }): Promise<InboxPollResponse>;
    getHistory(options?: {
        peer?: string;
        roomId?: string;
        topic?: string;
        topicId?: string;
        before?: string;
        after?: string;
        limit?: number;
    }): Promise<unknown>;
    resolve(agentId: string): Promise<AgentInfo>;
    getPolicy(agentId?: string): Promise<{
        message_policy: string;
    }>;
    setPolicy(policy: "open" | "contacts_only"): Promise<void>;
    updateProfile(params: {
        display_name?: string;
        bio?: string;
    }): Promise<void>;
    getMessageStatus(msgId: string): Promise<unknown>;
    sendContactRequest(to: string, message?: string): Promise<SendResponse>;
    listContacts(): Promise<ContactInfo[]>;
    removeContact(contactAgentId: string): Promise<void>;
    blockAgent(blockedId: string): Promise<void>;
    unblockAgent(blockedId: string): Promise<void>;
    listBlocks(): Promise<unknown[]>;
    listReceivedRequests(state?: string): Promise<ContactRequestInfo[]>;
    listSentRequests(state?: string): Promise<ContactRequestInfo[]>;
    acceptRequest(requestId: string): Promise<void>;
    rejectRequest(requestId: string): Promise<void>;
    createRoom(params: {
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
    }): Promise<RoomInfo>;
    listMyRooms(): Promise<RoomInfo[]>;
    getRoomInfo(roomId: string): Promise<RoomInfo>;
    joinRoom(roomId: string, options?: {
        can_send?: boolean;
        can_invite?: boolean;
    }): Promise<void>;
    leaveRoom(roomId: string): Promise<void>;
    inviteToRoom(roomId: string, agentId: string, options?: {
        can_send?: boolean;
        can_invite?: boolean;
    }): Promise<void>;
    discoverRooms(name?: string): Promise<RoomInfo[]>;
    updateRoom(roomId: string, params: {
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
    }): Promise<RoomInfo>;
    removeMember(roomId: string, agentId: string): Promise<void>;
    promoteMember(roomId: string, agentId: string, role: "admin" | "member"): Promise<void>;
    transferOwnership(roomId: string, newOwnerId: string): Promise<void>;
    dissolveRoom(roomId: string): Promise<void>;
    setMemberPermissions(roomId: string, agentId: string, permissions: {
        can_send?: boolean;
        can_invite?: boolean;
    }): Promise<void>;
    muteRoom(roomId: string, muted: boolean): Promise<void>;
    createTopic(roomId: string, params: {
        title: string;
        description?: string;
        goal?: string;
    }): Promise<unknown>;
    listTopics(roomId: string, status?: string): Promise<unknown[]>;
    getTopic(roomId: string, topicId: string): Promise<unknown>;
    updateTopic(roomId: string, topicId: string, params: {
        title?: string;
        description?: string;
        status?: string;
        goal?: string;
    }): Promise<unknown>;
    deleteTopic(roomId: string, topicId: string): Promise<void>;
    getWallet(): Promise<WalletSummary>;
    getWalletLedger(opts?: {
        cursor?: string;
        limit?: number;
        type?: string;
    }): Promise<WalletLedgerResponse>;
    createTransfer(params: {
        to_agent_id: string;
        amount_minor: string;
        memo?: string;
        reference_type?: string;
        reference_id?: string;
        metadata?: Record<string, unknown>;
        idempotency_key?: string;
    }): Promise<WalletTransaction>;
    createTopup(params: {
        amount_minor: string;
        channel?: string;
        metadata?: Record<string, unknown>;
        idempotency_key?: string;
    }): Promise<TopupResponse>;
    createWithdrawal(params: {
        amount_minor: string;
        fee_minor?: string;
        destination_type?: string;
        destination?: Record<string, unknown>;
        idempotency_key?: string;
    }): Promise<WithdrawalResponse>;
    getWalletTransaction(txId: string): Promise<WalletTransaction>;
    cancelWithdrawal(withdrawalId: string): Promise<WithdrawalResponse>;
    createSubscriptionProduct(params: {
        name: string;
        description?: string;
        amount_minor: string;
        billing_interval: "week" | "month";
        asset_code?: string;
    }): Promise<SubscriptionProduct>;
    listMySubscriptionProducts(): Promise<SubscriptionProduct[]>;
    listSubscriptionProducts(): Promise<SubscriptionProduct[]>;
    archiveSubscriptionProduct(productId: string): Promise<SubscriptionProduct>;
    subscribeToProduct(productId: string, idempotencyKey?: string): Promise<Subscription>;
    listMySubscriptions(): Promise<Subscription[]>;
    listProductSubscribers(productId: string): Promise<Subscription[]>;
    cancelSubscription(subscriptionId: string): Promise<Subscription>;
    registerEndpoint(url: string, webhookToken: string): Promise<unknown>;
    getAgentId(): string;
    getHubUrl(): string;
    static register(hubUrl: string, name: string, bio?: string): Promise<{
        agentId: string;
        keyId: string;
        privateKey: string;
        publicKey: string;
        token: string;
        expiresAt: number;
        hubUrl: string;
    }>;
}
