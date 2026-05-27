/**
 * Wire types for the runtime direct-session frames exchanged between
 * `gateway-ingress` and a cloud daemon over the runtime WebSocket. The
 * runtime WS is payload-opaque to the Hub — these frames flow either
 * straight from ingress to the cloud daemon (Option A) or via a Hub
 * relay that does not parse them (Option B). See
 * `docs/cloud-gateway-ingress-technical-design.md` §8 for the choice.
 *
 * Shared here (rather than in the daemon-only package) because both
 * `gateway-ingress` (Node service) and the cloud daemon need to agree on
 * frame names, field order, and conversation/turn ids. The Hub does not
 * need to know these shapes; if a relay implementation logs frame ids
 * for observability it should treat the rest as opaque bytes.
 */

/** Provider tag carried on every runtime frame, matching the wire shape. */
export type RuntimeGatewayProvider = "telegram" | "wechat" | "feishu";

/**
 * Conversation kind reported by the provider adapter. `direct` is a 1:1 chat
 * with a single sender; `group` is a multi-party room. Provider adapters
 * collapse subtypes (e.g. Telegram supergroup vs group) into these two
 * buckets so runtime-side dispatcher logic stays provider-agnostic.
 */
export type RuntimeGatewayConversationKind = "direct" | "group";

/**
 * Sender kind. Mostly `user`; reserved values exist for bots and provider
 * system messages so the runtime can apply trust differently.
 */
export type RuntimeGatewaySenderKind = "user" | "agent" | "system";

/**
 * Normalized inbound message payload carried inside the `gateway_inbound`
 * runtime frame. Mirrors the daemon-side `GatewayInboundMessage` but with
 * an explicit shape that does not depend on the daemon package — the
 * gateway-ingress service builds this from provider events and the cloud
 * daemon reads it through this exact contract.
 *
 * Field semantics:
 *
 * - `id` is the dedupe key inside the runtime (provider event id usually).
 * - `channel` is the ingress channel id (`gw_tg_xxx` etc.), useful for the
 *   runtime to scope per-channel state.
 * - `accountId` is the BotCord agent id (`ag_…`).
 * - `conversation.id` is the stable provider conversation key prefixed by
 *   provider name, e.g. `telegram:user:123` or `telegram:chat:-1001`.
 * - `text` is the plain-text body. Attachments and rich payloads are not
 *   surfaced through this frame in the MVP — they would land as future
 *   typed fields (`attachments`, `payload`, …).
 */
export interface RuntimeGatewayInboundPayload {
  id: string;
  channel: string;
  accountId: string;
  conversation: {
    id: string;
    kind: RuntimeGatewayConversationKind;
    title?: string;
    threadId?: string | null;
  };
  sender: {
    id: string;
    name?: string;
    kind: RuntimeGatewaySenderKind;
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

/**
 * Frame the gateway-ingress pushes to the cloud daemon to wake an agent.
 *
 * `event_id` is the ingress-side durable id (see
 * `gateway_inbound_events.event_id`). It is the same value carried on the
 * matching outbound frames so the runtime side can resume a partially
 * sent reply after a brief disconnect. `provider` is duplicated from
 * `message.channel`-derived metadata for trivial routing on the daemon
 * side without parsing the channel id.
 */
export interface GatewayInboundFrame {
  type: "gateway_inbound";
  event_id: string;
  gateway_id: string;
  agent_id: string;
  provider: RuntimeGatewayProvider;
  message: RuntimeGatewayInboundPayload;
}

/**
 * Ack frame returned by the cloud daemon as soon as the inbound has a
 * durable owner inside the runtime — at the latest after the dispatcher
 * has accepted the message and enqueued the turn. ingress marks the
 * event as `delivering` on receipt; final `delivered` state requires an
 * `gateway_outbound_complete` (or `…_error`).
 *
 * Optional `runtime_session_id` lets ingress know which session this
 * turn was attached to; ingress does not need to act on it but
 * persisting it makes downstream debugging easier.
 */
export interface GatewayInboundAckFrame {
  type: "gateway_inbound_ack";
  event_id: string;
  accepted: boolean;
  runtime_session_id?: string;
  /** Set when `accepted === false`. */
  error?: {
    code: string;
    message: string;
  };
}

/** Hint frame emitted by the runtime when a turn starts streaming. */
export interface GatewayOutboundStartFrame {
  type: "gateway_outbound_start";
  event_id: string;
  turn_id: string;
  gateway_id: string;
  agent_id: string;
  conversation_id: string;
}

/**
 * Incremental delta for streaming replies. Providers without native
 * streaming (WeChat) will see at most a single delta plus a complete
 * frame — ingress is free to coalesce. Telegram-style "edit message"
 * adapters can use deltas to rewrite an existing provider message.
 */
export interface GatewayOutboundDeltaFrame {
  type: "gateway_outbound_delta";
  event_id: string;
  turn_id: string;
  gateway_id: string;
  agent_id: string;
  conversation_id: string;
  delta: string;
}

/** Terminal frame carrying the final visible text for the reply. */
export interface GatewayOutboundCompleteFrame {
  type: "gateway_outbound_complete";
  event_id: string;
  turn_id: string;
  gateway_id: string;
  agent_id: string;
  conversation_id: string;
  final_text: string;
  /** Provider message id from a previously-sent partial, when re-using. */
  provider_message_id?: string | null;
}

/**
 * Hard error reported by the cloud daemon for an in-flight turn. ingress
 * surfaces this as a final delivery failure for the matching event id.
 * For typed retry policies the daemon can hint via `retryable` — ingress
 * defaults to non-retryable when absent.
 */
export interface GatewayOutboundErrorFrame {
  type: "gateway_outbound_error";
  event_id: string;
  turn_id: string;
  gateway_id: string;
  agent_id: string;
  conversation_id: string;
  code: string;
  message: string;
  retryable?: boolean;
}

/**
 * Heartbeat carried over the runtime WS; both sides may send. ingress
 * uses it to detect a half-open socket so retries on the upstream
 * provider can be paced by the runtime liveness rather than blind
 * timers.
 */
export interface RuntimeHeartbeatFrame {
  type: "runtime_heartbeat";
  ts: number;
}

/**
 * Ephemeral presence hint: the runtime is "thinking" / about to reply.
 * ingress maps this to the provider's typing affordance (Telegram
 * `sendChatAction`, WeChat `sendtyping`, Feishu reaction). There is no
 * paired `stopped` frame on the wire — provider typing states naturally
 * clear when the outbound complete/error arrives, and most providers
 * (WeChat especially) treat typing as a short-lived one-shot.
 */
export interface GatewayOutboundTypingFrame {
  type: "gateway_outbound_typing";
  event_id: string;
  turn_id: string;
  gateway_id: string;
  agent_id: string;
  conversation_id: string;
  /** `started` is the only value emitted today; reserved for future stop semantics. */
  phase: "started" | "stopped";
  /** Provider trace id (iLink `context_token` lookup, Feishu message id, …). */
  trace_id?: string | null;
}

/**
 * Union of all outbound (cloud daemon → ingress) frames the ingress
 * reads on the runtime WS. Each frame is line-delimited JSON.
 */
export type RuntimeOutboundFrame =
  | GatewayInboundAckFrame
  | GatewayOutboundStartFrame
  | GatewayOutboundDeltaFrame
  | GatewayOutboundCompleteFrame
  | GatewayOutboundErrorFrame
  | GatewayOutboundTypingFrame
  | RuntimeHeartbeatFrame;

/**
 * Union of all inbound (ingress → cloud daemon) frames the runtime
 * reads. ingress is the only writer of `gateway_inbound`; heartbeats are
 * bidirectional.
 */
export type RuntimeInboundFrame = GatewayInboundFrame | RuntimeHeartbeatFrame;

/** Well-known runtime frame type strings — handy for switch lookups. */
export const RUNTIME_FRAME_TYPES = {
  GATEWAY_INBOUND: "gateway_inbound",
  GATEWAY_INBOUND_ACK: "gateway_inbound_ack",
  GATEWAY_OUTBOUND_START: "gateway_outbound_start",
  GATEWAY_OUTBOUND_DELTA: "gateway_outbound_delta",
  GATEWAY_OUTBOUND_COMPLETE: "gateway_outbound_complete",
  GATEWAY_OUTBOUND_ERROR: "gateway_outbound_error",
  GATEWAY_OUTBOUND_TYPING: "gateway_outbound_typing",
  RUNTIME_HEARTBEAT: "runtime_heartbeat",
} as const;

export type RuntimeFrameType =
  (typeof RUNTIME_FRAME_TYPES)[keyof typeof RUNTIME_FRAME_TYPES];

// ---------------------------------------------------------------------------
// Hub thin lifecycle API contract
//
// The gateway-ingress calls a tiny Hub-internal HTTP API to ensure a paused
// cloud sandbox comes back online. Shapes mirror
// `docs/cloud-gateway-ingress-technical-design.md` §7 verbatim; both sides
// of the wire share these to avoid drift.
// ---------------------------------------------------------------------------

/** Reason taxonomy for `ensure-running`. */
export type EnsureRunningReason =
  | "third_party_inbound"
  | "manual_resume"
  | "scheduled_wake";

/**
 * Request body for `POST /internal/cloud-gateway/agents/{agent_id}/ensure-running`.
 * `event_id` is the durable inbound event so the Hub can log which provider
 * inbound triggered the resume (without seeing the message body).
 */
export interface EnsureRunningRequest {
  gateway_id: string;
  reason: EnsureRunningReason;
  event_id?: string;
}

/**
 * Sandbox lifecycle states surfaced by the thin API. The values match
 * `CloudAgentInstance.status` semantics with a coarser bucket so ingress
 * does not need to learn every internal state.
 */
export type CloudRuntimeStatus =
  | "provisioning"
  | "ready"
  | "paused"
  | "failed"
  | "deleted";

/**
 * Short-lived runtime session metadata. Tokens are scoped to one ingress
 * service, one agent, and one event/session — never the user's main JWT.
 * `expires_in` is seconds; ingress refreshes by calling the API again.
 */
export interface RuntimeSessionMetadata {
  session_endpoint: string;
  session_token: string;
  expires_in: number;
}

/** Response shape from `ensure-running` and `runtime` GET. */
export interface EnsureRunningResponse {
  agent_id: string;
  status: CloudRuntimeStatus;
  cloud_daemon_instance_id?: string;
  /** Present when `status === "ready"`. */
  runtime?: RuntimeSessionMetadata;
  /** Populated when `status === "failed"`. */
  error?: {
    code: string;
    message: string;
  };
}

/** Request body for `POST /internal/cloud-gateway/agents/{agent_id}/touch`. */
export interface TouchRuntimeRequest {
  gateway_id: string;
  /** Free-form context (e.g. `inbound_delivered`, `outbound_sent`). */
  reason?: string;
}

/** Response for `touch`. */
export interface TouchRuntimeResponse {
  agent_id: string;
  acknowledged_at: number;
}
