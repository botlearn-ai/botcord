import { randomUUID } from "node:crypto";

import type {
  EnsureRunningResponse,
  GatewayInboundFrame,
  RuntimeGatewayInboundPayload,
  RuntimeOutboundFrame,
  RuntimeSessionMetadata,
} from "@botcord/protocol-core";
import { RUNTIME_FRAME_TYPES } from "@botcord/protocol-core";

import type { HubClient } from "./hub-client.js";
import type { IngressLogger } from "./log.js";
import { RuntimeSessionManager } from "./runtime/session.js";
import type { ProviderAdapter } from "./providers/types.js";
import type { IngressStore } from "./storage/store.js";
import type { GatewayInboundMessage } from "@botcord/protocol-core";
import type {
  GatewayConnection,
  InboundEvent,
  OutboundSendRequest,
} from "./types.js";

/**
 * Glue between provider adapters, durable storage, the Hub thin
 * lifecycle API, and the runtime WS. Adapters never touch any of these
 * directly — the orchestrator is the only piece that knows the wire
 * shapes and resume semantics.
 */
export interface OrchestratorOptions {
  store: IngressStore;
  hub: HubClient;
  runtime: RuntimeSessionManager;
  log: IngressLogger;
  dedupeCapacity?: number;
  /**
   * Optional clock override for tests. Defaults to `Date.now`.
   */
  now?: () => number;
}

export class IngressOrchestrator {
  private readonly now: () => number;
  /** Track provider adapters so we can call their `send()` for outbound. */
  private readonly providers = new Map<string, ProviderAdapter>();
  /** Pending acks keyed by event id. */
  private readonly pendingAcks = new Map<
    string,
    { resolve: (accepted: boolean) => void; reject: (err: Error) => void }
  >();

  constructor(private readonly opts: OrchestratorOptions) {
    this.now = opts.now ?? (() => Date.now());
  }

  // -------------------------------------------------------------------
  // Provider lifecycle
  // -------------------------------------------------------------------

  registerProvider(adapter: ProviderAdapter): void {
    this.providers.set(adapter.gatewayId, adapter);
  }

  unregisterProvider(gatewayId: string): void {
    this.providers.delete(gatewayId);
  }

  /**
   * Persist a normalized inbound message, dedupe, then drive the
   * ensure-running → runtime-deliver path.
   *
   * Adapters call this via `ProviderRuntimeContext.emit`. Return value
   * mirrors that contract:
   *
   *   - `true`  — durable write succeeded; cursor may advance.
   *   - `false` — duplicate, already seen; cursor may advance.
   *
   * Throws when the durable write failed; the adapter MUST NOT advance
   * its cursor.
   */
  async ingest(
    gatewayId: string,
    message: GatewayInboundMessage,
    providerEventId: string,
  ): Promise<boolean> {
    const connection = this.opts.store.getConnection(gatewayId);
    if (!connection) {
      throw new Error(`ingress: unknown gateway ${gatewayId}`);
    }

    if (this.opts.store.hasProviderEventId(gatewayId, providerEventId)) {
      this.opts.log.debug("ingest skipped — duplicate", { gatewayId, providerEventId });
      return false;
    }

    const event: InboundEvent = {
      eventId: this.newEventId(),
      gatewayId,
      agentId: connection.agentId,
      provider: connection.provider,
      providerEventId,
      conversationId: message.conversation.id,
      senderId: message.sender.id,
      normalizedMessage: message,
      status: "queued",
      attemptCount: 0,
      createdAt: this.now(),
      updatedAt: this.now(),
    };
    this.opts.store.insertEvent(event);
    this.opts.store.appendDedupe(gatewayId, providerEventId, this.opts.dedupeCapacity);
    this.opts.log.info("ingest queued", {
      gatewayId,
      providerEventId,
      eventId: event.eventId,
      conversationId: message.conversation.id,
    });

    void this.dispatchEvent(event.eventId).catch((err) => {
      this.opts.log.error("dispatchEvent failed", {
        eventId: event.eventId,
        err: String(err),
      });
    });

    return true;
  }

  /**
   * Resume queued events that were left in `queued` / `delivering` on
   * boot. Each event triggers a fresh ensure-running + runtime delivery
   * attempt. Failures move the event to `failed` after a single retry.
   */
  async resumePending(): Promise<void> {
    for (const event of this.opts.store.listEventsByStatus("queued", "delivering")) {
      await this.dispatchEvent(event.eventId);
    }
  }

  /**
   * Core delivery path:
   *
   * 1. ensure-running (Hub API) — refreshes the sandbox + runtime
   *    metadata.
   * 2. Open / reuse the runtime WS session.
   * 3. Send the `gateway_inbound` frame.
   * 4. Wait for the daemon's `gateway_inbound_ack` and mark the event
   *    as `delivering`. Outbound completion frames will move it
   *    further along.
   */
  async dispatchEvent(eventId: string): Promise<void> {
    const event = this.opts.store.getEvent(eventId);
    if (!event) return;
    if (event.status === "delivered") return;

    const connection = this.opts.store.getConnection(event.gatewayId);
    if (!connection) {
      this.opts.store.updateEvent(event.eventId, {
        status: "failed",
        lastError: "gateway_not_found",
      });
      return;
    }

    let runtimeMeta: RuntimeSessionMetadata | null = null;
    let cloudDaemonInstanceId: string | undefined;
    try {
      const res = await this.opts.hub.ensureRunning(connection.agentId, {
        gateway_id: connection.id,
        reason: "third_party_inbound",
        event_id: event.eventId,
      });
      ({ runtime: runtimeMeta = null, cloud_daemon_instance_id: cloudDaemonInstanceId } =
        res as EnsureRunningResponse & { runtime?: RuntimeSessionMetadata | null });
      if (res.status === "failed") {
        this.opts.store.updateEvent(event.eventId, {
          status: "failed",
          lastError: `hub_status_failed:${res.error?.code ?? "unknown"}`,
        });
        return;
      }
      if (res.status !== "ready" || !runtimeMeta) {
        // Sandbox not ready yet — leave queued for the next pass.
        this.opts.store.updateEvent(event.eventId, {
          status: "queued",
          attemptCount: event.attemptCount + 1,
          lastError: `hub_status_${res.status}`,
        });
        return;
      }
    } catch (err) {
      this.opts.store.updateEvent(event.eventId, {
        status: "queued",
        attemptCount: event.attemptCount + 1,
        lastError: `ensure_running_failed: ${String(err)}`,
      });
      return;
    }

    try {
      await this.opts.runtime.ensureSession(connection.agentId, connection.id, runtimeMeta);
    } catch (err) {
      this.opts.store.updateEvent(event.eventId, {
        status: "queued",
        attemptCount: event.attemptCount + 1,
        lastError: `runtime_session_failed: ${String(err)}`,
      });
      return;
    }

    const payload: RuntimeGatewayInboundPayload = {
      id: event.normalizedMessage.id,
      channel: event.gatewayId,
      accountId: event.agentId,
      conversation: event.normalizedMessage.conversation,
      sender: event.normalizedMessage.sender,
      ...(event.normalizedMessage.text !== undefined
        ? { text: event.normalizedMessage.text }
        : {}),
      ...(event.normalizedMessage.replyTo !== undefined
        ? { replyTo: event.normalizedMessage.replyTo }
        : {}),
      ...(event.normalizedMessage.mentioned !== undefined
        ? { mentioned: event.normalizedMessage.mentioned }
        : {}),
      receivedAt: event.normalizedMessage.receivedAt,
      ...(event.normalizedMessage.trace ? { trace: event.normalizedMessage.trace } : {}),
    };
    const frame: GatewayInboundFrame = {
      type: RUNTIME_FRAME_TYPES.GATEWAY_INBOUND,
      event_id: event.eventId,
      gateway_id: connection.id,
      agent_id: connection.agentId,
      provider: connection.provider,
      message: payload,
    };

    this.opts.store.updateEvent(event.eventId, {
      status: "delivering",
      attemptCount: event.attemptCount + 1,
    });

    try {
      await this.opts.runtime.sendInbound(frame);
    } catch (err) {
      this.opts.store.updateEvent(event.eventId, {
        status: "queued",
        lastError: `send_failed: ${String(err)}`,
      });
      return;
    }

    if (cloudDaemonInstanceId) {
      // Log-only: useful when tracing which sandbox a delivery hit.
      this.opts.log.debug("frame sent", {
        eventId: event.eventId,
        cloudDaemonInstanceId,
      });
    }
  }

  // -------------------------------------------------------------------
  // Runtime → ingress frames
  // -------------------------------------------------------------------

  /**
   * Bound to `RuntimeSessionManager.hooks.onFrame`. Mutates event /
   * delivery rows based on `gateway_inbound_ack` / outbound frames and
   * forwards outbound payloads to the provider adapter.
   */
  async onRuntimeFrame(_agentId: string, frame: RuntimeOutboundFrame): Promise<void> {
    switch (frame.type) {
      case RUNTIME_FRAME_TYPES.GATEWAY_INBOUND_ACK: {
        const pending = this.pendingAcks.get(frame.event_id);
        if (pending) {
          pending.resolve(frame.accepted);
          this.pendingAcks.delete(frame.event_id);
        }
        if (!frame.accepted) {
          this.opts.store.updateEvent(frame.event_id, {
            status: "failed",
            lastError: frame.error
              ? `daemon_rejected:${frame.error.code}`
              : "daemon_rejected",
          });
        }
        return;
      }
      case RUNTIME_FRAME_TYPES.GATEWAY_OUTBOUND_START: {
        this.ensureDeliveryFor(frame.event_id, frame.gateway_id, frame.conversation_id, frame.turn_id);
        return;
      }
      case RUNTIME_FRAME_TYPES.GATEWAY_OUTBOUND_DELTA: {
        // MVP — no streaming; orchestrator just records last text hash.
        const delivery = this.ensureDeliveryFor(
          frame.event_id,
          frame.gateway_id,
          frame.conversation_id,
          frame.turn_id,
        );
        this.opts.store.updateDelivery(delivery.deliveryId, {
          lastTextHash: hashText(frame.delta),
          status: "streaming",
        });
        return;
      }
      case RUNTIME_FRAME_TYPES.GATEWAY_OUTBOUND_COMPLETE: {
        const provider = this.providers.get(frame.gateway_id);
        if (!provider) {
          this.opts.log.error("no provider for outbound complete", {
            gatewayId: frame.gateway_id,
          });
          this.opts.store.updateEvent(frame.event_id, {
            status: "failed",
            lastError: "provider_not_registered",
          });
          return;
        }
        const delivery = this.ensureDeliveryFor(
          frame.event_id,
          frame.gateway_id,
          frame.conversation_id,
          frame.turn_id,
        );

        const sendRequest: OutboundSendRequest = {
          gatewayId: frame.gateway_id,
          conversationId: frame.conversation_id,
          text: frame.final_text,
          turnId: frame.turn_id,
          final: true,
        };

        try {
          const result = await provider.send(sendRequest);
          this.opts.store.updateDelivery(delivery.deliveryId, {
            status: "sent",
            providerMessageId: result.providerMessageId ?? null,
            lastTextHash: hashText(frame.final_text),
          });
          this.opts.store.updateEvent(frame.event_id, {
            status: "delivered",
          });
          // Best-effort touch — refresh activity tracker on the Hub.
          try {
            await this.opts.hub.touch(frame.agent_id, {
              gateway_id: frame.gateway_id,
              reason: "outbound_sent",
            });
          } catch (err) {
            this.opts.log.warn("touch failed", { err: String(err) });
          }
        } catch (err) {
          this.opts.store.updateDelivery(delivery.deliveryId, {
            status: "failed",
            lastError: String(err),
          });
          this.opts.store.updateEvent(frame.event_id, {
            status: "failed",
            lastError: `provider_send_failed: ${String(err)}`,
          });
        }
        return;
      }
      case RUNTIME_FRAME_TYPES.GATEWAY_OUTBOUND_ERROR: {
        this.opts.store.updateEvent(frame.event_id, {
          status: "failed",
          lastError: `runtime_error:${frame.code}`,
        });
        const delivery = this.opts.store.getDeliveryByEvent(frame.event_id);
        if (delivery) {
          this.opts.store.updateDelivery(delivery.deliveryId, {
            status: "failed",
            lastError: frame.message,
          });
        }
        return;
      }
      case RUNTIME_FRAME_TYPES.GATEWAY_OUTBOUND_TYPING: {
        const provider = this.providers.get(frame.gateway_id);
        if (!provider || typeof provider.typing !== "function") return;
        try {
          await provider.typing({
            gatewayId: frame.gateway_id,
            conversationId: frame.conversation_id,
            turnId: frame.turn_id,
            phase: frame.phase,
            traceId: frame.trace_id ?? null,
          });
        } catch (err) {
          this.opts.log.warn("provider typing failed", {
            gatewayId: frame.gateway_id,
            eventId: frame.event_id,
            err: String(err),
          });
        }
        return;
      }
      case RUNTIME_FRAME_TYPES.RUNTIME_HEARTBEAT: {
        // Heartbeats are observed only.
        return;
      }
    }
  }

  onRuntimeClose(agentId: string, reason: string): void {
    this.opts.log.info("runtime closed; requeueing in-flight events", { agentId, reason });
    for (const event of this.opts.store.listEventsByStatus("delivering")) {
      if (event.agentId === agentId) {
        this.opts.store.updateEvent(event.eventId, {
          status: "queued",
          lastError: `runtime_closed:${reason}`,
        });
      }
    }
  }

  // -------------------------------------------------------------------
  // Outbound helpers (mainly for tests)
  // -------------------------------------------------------------------

  /** Force a provider send out-of-band (used by tooling and tests). */
  async sendProviderOutbound(
    gatewayId: string,
    request: Omit<OutboundSendRequest, "gatewayId">,
  ): Promise<{ providerMessageId?: string | null }> {
    const provider = this.providers.get(gatewayId);
    if (!provider) throw new Error(`no provider registered for ${gatewayId}`);
    return provider.send({ gatewayId, ...request });
  }

  // -------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------

  private ensureDeliveryFor(
    eventId: string,
    gatewayId: string,
    conversationId: string,
    turnId: string,
  ) {
    const existing = this.opts.store.getDeliveryByEvent(eventId);
    if (existing) return existing;
    const row = {
      deliveryId: `del_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
      eventId,
      gatewayId,
      conversationId,
      turnId,
      status: "streaming" as const,
      createdAt: this.now(),
      updatedAt: this.now(),
    };
    this.opts.store.insertDelivery(row);
    return row;
  }

  private newEventId(): string {
    return `evt_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  }

  /** Resolve the connection row for a given gateway id. */
  getConnection(gatewayId: string): GatewayConnection | null {
    return this.opts.store.getConnection(gatewayId);
  }
}

function hashText(text: string): string {
  // Tiny, dependency-free hash — only used for change detection
  // bookkeeping. Cryptographic strength is not required.
  let h = 5381;
  for (let i = 0; i < text.length; i++) {
    h = ((h << 5) + h) ^ text.charCodeAt(i);
  }
  return (h >>> 0).toString(36);
}
