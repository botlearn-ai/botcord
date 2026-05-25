import type { GatewayInboundMessage } from "@botcord/protocol-core";
import type { IngressLogger } from "../log.js";
import type {
  GatewayConnection,
  OutboundSendRequest,
  OutboundSendResult,
} from "../types.js";

/**
 * Adapter shared shape — mirrors the daemon `ChannelAdapter` but with
 * dependencies surfaced explicitly so the ingress orchestrator can
 * supply its durable storage, hub client, and secret resolution.
 *
 * Adapters poll / subscribe upstream, normalize messages, and emit them
 * via `ctx.emit`. The orchestrator owns durable persistence, dedupe,
 * ensure-running, and runtime delivery; adapters never touch those.
 */
export interface ProviderAdapter {
  readonly gatewayId: string;
  readonly provider: GatewayConnection["provider"];

  start(ctx: ProviderRuntimeContext): Promise<void>;
  stop(reason?: string): Promise<void>;
  send(request: OutboundSendRequest): Promise<OutboundSendResult>;
}

/**
 * Per-provider runtime context. Adapters receive a fully-resolved
 * connection row + secret payload and emit normalized messages back
 * through `emit`. Cursor / dedupe persistence lives entirely on the
 * orchestrator side via `persistCursor` so adapters stay stateless.
 */
export interface ProviderRuntimeContext {
  connection: GatewayConnection;
  secret: Record<string, unknown>;
  log: IngressLogger;
  abortSignal: AbortSignal;
  /**
   * Submit one normalized inbound message. The orchestrator handles
   * dedupe, durable persistence, runtime delivery, and finally returns
   * here so the adapter can decide whether to advance its cursor.
   *
   * Returns `true` if the orchestrator accepted the message (durable
   * write succeeded), `false` if the message was a duplicate, or
   * throws when ingestion failed and the cursor must NOT advance.
   */
  emit(message: GatewayInboundMessage, providerEventId: string): Promise<boolean>;
  /**
   * Persist a provider cursor blob. Called only after `emit` succeeded
   * for every message in the batch — never before.
   */
  persistCursor(cursor: Record<string, unknown>): void;
  /** Load the most recent persisted cursor. Returns `{}` on first start. */
  loadCursor(): Record<string, unknown>;
  /** Update the connection's `lastPollAt` / `lastInboundAt` markers. */
  markActivity(patch: { lastPollAt?: number; lastInboundAt?: number; lastError?: string | null }): void;
}

/**
 * Factory contract used by the registry. Provider modules export one of
 * these so adding a provider is a single one-line registration.
 */
export type ProviderAdapterFactory = (gatewayId: string) => ProviderAdapter;
