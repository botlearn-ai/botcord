/**
 * Canonical gateway message shapes shared by `packages/daemon` channel
 * adapters and `packages/gateway-ingress` provider adapters.
 *
 * The wire-level subset of {@link GatewayInboundMessage} is
 * `RuntimeGatewayInboundPayload` (see runtime-frame.ts) — the runtime WS
 * carries the trimmed shape (no `raw` field) because cloud daemons should
 * not depend on provider-original payloads. Local daemon channel adapters
 * can still attach `raw` for debug/logging when they consume their own
 * upstream events.
 *
 * Keep this file free of imports from individual provider SDKs; only
 * primitive types and re-exports.
 */

import type { RuntimeGatewayInboundPayload } from "./runtime-frame.js";

/**
 * Normalized inbound message produced by any gateway channel/provider
 * adapter. Identical to {@link RuntimeGatewayInboundPayload} plus an
 * optional `raw` field that local daemon adapters use to keep the
 * provider-original payload for debugging. The runtime WS still only
 * carries the wire subset; do not put non-serializable values in `raw`.
 */
export interface GatewayInboundMessage extends RuntimeGatewayInboundPayload {
  /**
   * Provider-original event payload. Optional because the wire-level
   * shape (`RuntimeGatewayInboundPayload`) omits it. Daemon adapters
   * populate it for telemetry; ingress adapters typically leave it
   * unset since the orchestrator does not need it.
   */
  raw?: unknown;
}

/**
 * Outbound attachment passed alongside a reply. Either `filePath` (local
 * file readable by the daemon) or `data` (in-memory bytes) must be set;
 * `filename` and `contentType` are advisory. `kind` lets adapters dispatch
 * the upload through provider-specific paths (image vs file vs video).
 */
export interface GatewayOutboundAttachment {
  filePath?: string;
  data?: Uint8Array;
  filename?: string;
  contentType?: string;
  kind?: "image" | "file" | "video";
}

/**
 * Outbound reply envelope produced by the dispatcher and consumed by a
 * channel/provider adapter. Ingress's per-call `OutboundSendRequest` is
 * a strict subset of this — adapters that need richer fields (replyTo,
 * attachments, traceId) read them off here.
 */
export interface GatewayOutboundMessage {
  channel: string;
  accountId: string;
  conversationId: string;
  threadId?: string | null;
  type?: "message" | "error";
  text: string;
  attachments?: GatewayOutboundAttachment[];
  replyTo?: string | null;
  traceId?: string | null;
}

/**
 * Inbound envelope wrapping a normalized message with optional upstream
 * ack callbacks. The daemon uses this through `ChannelAdapter.emit`; the
 * ingress orchestrator does its own durable-write + boolean handshake
 * and does not consume the `ack` field.
 */
export interface GatewayInboundEnvelope {
  message: GatewayInboundMessage;
  ack?: {
    accept(): Promise<void>;
    reject?(reason: string): Promise<void>;
  };
}
