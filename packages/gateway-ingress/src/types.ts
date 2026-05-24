import type { RuntimeGatewayProvider } from "@botcord/protocol-core";

/**
 * Local types describing on-disk + in-memory shapes for the ingress
 * service. Mirror the §9 data-model in
 * `docs/cloud-gateway-ingress-technical-design.md`. SQLite-equivalent
 * tables are modeled as plain objects so a future migration to a
 * relational backend stays mechanical.
 */

export type GatewayStatus = "active" | "disabled" | "pending" | "error";

export interface GatewayConnection {
  id: string;
  agentId: string;
  userId?: string;
  provider: RuntimeGatewayProvider;
  label?: string;
  status: GatewayStatus;
  enabled: boolean;
  /**
   * Provider-specific runtime config (allowlists, baseUrl, …). The shape
   * mirrors the daemon's `GatewayChannelConfig` extras — see provider
   * adapters for keys they actually read.
   */
  config: Record<string, unknown>;
  /**
   * Reference into the local secret store. Provider adapters resolve
   * concrete secrets through this key — secrets never live in the
   * connection row to keep state-store and secret-store boundaries
   * separate.
   */
  secretRef?: string;
  createdAt: number;
  updatedAt: number;
}

export interface GatewayProviderState {
  gatewayId: string;
  cursor?: Record<string, unknown>;
  dedupe?: string[];
  lastPollAt?: number;
  lastInboundAt?: number;
  lastError?: string | null;
  updatedAt: number;
}

export type InboundEventStatus =
  | "received"
  | "queued"
  | "delivering"
  | "delivered"
  | "failed"
  | "dead_letter";

export interface InboundEvent {
  eventId: string;
  gatewayId: string;
  agentId: string;
  provider: RuntimeGatewayProvider;
  providerEventId: string;
  conversationId: string;
  senderId: string;
  normalizedMessage: NormalizedInboundMessage;
  status: InboundEventStatus;
  attemptCount: number;
  lastError?: string | null;
  createdAt: number;
  updatedAt: number;
}

/**
 * Normalized message payload mirroring the runtime-frame
 * `RuntimeGatewayInboundPayload`. Kept duplicated rather than imported
 * because the ingress writes this before any runtime frame is built,
 * and tests would otherwise depend on the shared package's compiled
 * output.
 */
export interface NormalizedInboundMessage {
  id: string;
  channel: string;
  accountId: string;
  conversation: {
    id: string;
    kind: "direct" | "group";
    title?: string;
    threadId?: string | null;
  };
  sender: {
    id: string;
    name?: string;
    kind: "user" | "agent" | "system";
  };
  text?: string;
  replyTo?: string | null;
  mentioned?: boolean;
  receivedAt: number;
  trace?: {
    id: string;
    streamable?: boolean;
  };
}

export type DeliveryStatus = "streaming" | "sent" | "failed";

export interface OutboundDelivery {
  deliveryId: string;
  eventId: string;
  gatewayId: string;
  conversationId: string;
  turnId?: string;
  providerMessageId?: string | null;
  status: DeliveryStatus;
  lastTextHash?: string;
  lastError?: string | null;
  createdAt: number;
  updatedAt: number;
}

/**
 * Send target passed by the provider runner to its provider adapter.
 * Mirrors the daemon-side `GatewayOutboundMessage` minus the daemon-only
 * channel id (provider adapters here resolve channel-id from the
 * gateway connection passed at construction).
 */
export interface OutboundSendRequest {
  gatewayId: string;
  conversationId: string;
  text: string;
  /** Sequence number for streaming; provider adapters may ignore. */
  turnId?: string;
  /** Hint that this is the final text and not a partial chunk. */
  final?: boolean;
}

export interface OutboundSendResult {
  providerMessageId?: string | null;
}
