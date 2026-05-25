import type {
  EnsureRunningRequest,
  EnsureRunningResponse,
  RuntimeSessionMetadata,
  TouchRuntimeRequest,
  TouchRuntimeResponse,
} from "@botcord/protocol-core";

import type { HubClient } from "../hub-client.js";
import { RUNTIME_SOCKET_STATE, type RuntimeSocketLike } from "../runtime/session.js";

/**
 * In-memory test doubles. The orchestrator/runner only need three
 * collaborators to be faked: the Hub thin API, the runtime WS, and
 * (optionally) the provider adapter for outbound.
 */

export class FakeHubClient implements HubClient {
  ensureRunningCalls: { agentId: string; body: EnsureRunningRequest }[] = [];
  touchCalls: { agentId: string; body: TouchRuntimeRequest }[] = [];
  ensureResponse: (req: EnsureRunningRequest) => EnsureRunningResponse = () => ({
    agent_id: "ag_test",
    status: "ready",
    cloud_daemon_instance_id: "cloud_dm_fake",
    runtime: this.defaultRuntime(),
  });

  defaultRuntime(): RuntimeSessionMetadata {
    return {
      session_endpoint: "ws://test/runtime",
      session_token: "tok_fake",
      expires_in: 300,
    };
  }

  async ensureRunning(
    agentId: string,
    body: EnsureRunningRequest,
  ): Promise<EnsureRunningResponse> {
    this.ensureRunningCalls.push({ agentId, body });
    return this.ensureResponse(body);
  }

  async getRuntime(agentId: string, params: { gatewayId: string; eventId?: string }): Promise<EnsureRunningResponse> {
    return this.ensureResponse({
      gateway_id: params.gatewayId,
      reason: "manual_resume",
      ...(params.eventId ? { event_id: params.eventId } : {}),
    });
  }

  async touch(agentId: string, body: TouchRuntimeRequest): Promise<TouchRuntimeResponse> {
    this.touchCalls.push({ agentId, body });
    return { agent_id: agentId, acknowledged_at: Date.now() };
  }
}

type SocketListener = (...args: unknown[]) => unknown;

/**
 * Bidirectional in-memory socket. `incoming(frame)` injects a frame
 * coming back from the runtime side; `sent` records frames that the
 * orchestrator pushed down. `open()` flips state to OPEN and fires
 * the open event.
 */
export class FakeRuntimeSocket implements RuntimeSocketLike {
  readyState: number = RUNTIME_SOCKET_STATE.CONNECTING;
  sent: string[] = [];
  private listeners = new Map<string, SocketListener[]>();

  constructor(autoOpen = true) {
    if (autoOpen) {
      // Defer to next tick so callers can attach `on("open")` first.
      queueMicrotask(() => this.open());
    }
  }

  send(data: string): void {
    if (this.readyState !== RUNTIME_SOCKET_STATE.OPEN) {
      throw new Error(`socket not open (state=${this.readyState})`);
    }
    this.sent.push(data);
  }

  close(code = 1000, reason = ""): void {
    if (this.readyState === RUNTIME_SOCKET_STATE.CLOSED) return;
    this.readyState = RUNTIME_SOCKET_STATE.CLOSED;
    this.emit("close", code, reason);
  }

  open(): void {
    if (this.readyState === RUNTIME_SOCKET_STATE.OPEN) return;
    this.readyState = RUNTIME_SOCKET_STATE.OPEN;
    this.emit("open");
  }

  incoming(frame: object): void {
    this.emit("message", JSON.stringify(frame));
  }

  on(event: "open", listener: () => void): unknown;
  on(event: "message", listener: (data: unknown) => void): unknown;
  on(event: "close", listener: (code: number, reason?: unknown) => void): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
  on(event: string, listener: (...args: never[]) => void): unknown {
    const list = this.listeners.get(event) ?? [];
    list.push(listener as SocketListener);
    this.listeners.set(event, list);
    return this;
  }

  off(event: string, listener: SocketListener): unknown {
    const list = this.listeners.get(event) ?? [];
    this.listeners.set(
      event,
      list.filter((fn) => fn !== listener),
    );
    return this;
  }

  private emit(event: string, ...args: unknown[]): void {
    for (const fn of this.listeners.get(event) ?? []) {
      try {
        fn(...args);
      } catch {
        // ignore — tests should fail visibly via other assertions
      }
    }
  }
}

/**
 * Minimal `ProviderAdapter` that does nothing. Use this when a test
 * needs to exercise the setup HTTP server end-to-end (which now starts
 * adapters after finalize/PATCH) but does NOT actually want to talk to
 * a third-party provider. Tests that want to observe whether `start`
 * was called can wrap the factory and flip a flag on entry.
 */
import type {
  ProviderAdapter,
  ProviderAdapterFactory,
} from "../providers/types.js";
import type { OutboundSendRequest, OutboundSendResult } from "../types.js";

export interface RecordingFactory {
  factory: ProviderAdapterFactory;
  starts: string[];
  stops: string[];
  /** Set to a thrown Error to force `adapter.start()` to reject. */
  startThrows?: Error;
}

export function makeRecordingFactory(provider: string): RecordingFactory {
  const starts: string[] = [];
  const stops: string[] = [];
  const rec: RecordingFactory = { factory: () => undefined as never, starts, stops };
  rec.factory = (gatewayId: string): ProviderAdapter => ({
    gatewayId,
    provider: provider as ProviderAdapter["provider"],
    async start(_ctx) {
      starts.push(gatewayId);
      if (rec.startThrows) throw rec.startThrows;
    },
    async stop(_reason) {
      stops.push(gatewayId);
    },
    async send(_req: OutboundSendRequest): Promise<OutboundSendResult> {
      return { providerMessageId: null };
    },
  });
  return rec;
}

export class FakeSocketFactory {
  sockets: FakeRuntimeSocket[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  next?: () => FakeRuntimeSocket;

  factory = async (
    _endpoint: string,
    _token: string,
  ): Promise<RuntimeSocketLike> => {
    const sock = this.next?.() ?? new FakeRuntimeSocket();
    this.sockets.push(sock);
    return sock;
  };
}
