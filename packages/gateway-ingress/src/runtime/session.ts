import type {
  GatewayInboundFrame,
  RuntimeOutboundFrame,
  RuntimeSessionMetadata,
} from "@botcord/protocol-core";

import type { IngressLogger } from "../log.js";

/**
 * Minimal `ws.WebSocket`-compatible surface so tests can supply an
 * in-process pipe without spawning a real socket. The runtime session
 * manager talks only to this interface — production callers wrap the
 * actual `ws` module.
 */
export interface RuntimeSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: "open", listener: () => void): unknown;
  on(event: "message", listener: (data: unknown) => void): unknown;
  on(event: "close", listener: (code: number, reason?: unknown) => void): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
  off?(event: string, listener: (...args: unknown[]) => void): unknown;
}

/** Status constants from the `ws` library. */
export const RUNTIME_SOCKET_STATE = {
  CONNECTING: 0,
  OPEN: 1,
  CLOSING: 2,
  CLOSED: 3,
} as const;

export type RuntimeSocketFactory = (
  endpoint: string,
  token: string,
) => Promise<RuntimeSocketLike>;

/**
 * Adapter passed by the orchestration loop to install routing.
 *
 *  - `onFrame(agentId, frame)` handles every parsed frame from the
 *    cloud daemon (`gateway_inbound_ack`, `gateway_outbound_*`,
 *    heartbeats). Errors are logged and swallowed so a buggy handler
 *    doesn't drop the WS.
 *
 *  - `onClose(agentId, reason)` lets the orchestrator clean up event
 *    deliveries that were left in `delivering` when the daemon dropped.
 */
export interface RuntimeSessionHooks {
  onFrame(agentId: string, frame: RuntimeOutboundFrame): void | Promise<void>;
  onClose(agentId: string, reason: string): void;
}

export interface RuntimeSessionManagerOptions {
  /**
   * Factory that opens a WS to the cloud daemon. Defaults to `new
   * WebSocket(endpoint, { headers: { Authorization: Bearer … } })`
   * from the `ws` module.
   */
  socketFactory: RuntimeSocketFactory;
  log: IngressLogger;
  hooks: RuntimeSessionHooks;
}

interface ActiveSession {
  agentId: string;
  socket: RuntimeSocketLike;
  metadata: RuntimeSessionMetadata;
  // Reject any send() attempts after the socket closes; resolved
  // immediately when open. Held as a promise so callers can await the
  // first open before posting an inbound frame.
  ready: Promise<void>;
  // Resolves when the session is unhealthy and the orchestrator can
  // tear it down without waiting for the next message.
  closed: Promise<void>;
  resolveClosed: () => void;
}

/**
 * Per-agent runtime WS lifecycle.
 *
 * The MVP keeps things simple: one persistent session per agent,
 * opened lazily on the first inbound frame. Closing happens through
 * `closeSession` (manual) or the upstream daemon dropping the socket.
 * Reconnect is the caller's responsibility — `ensureSession` re-opens
 * if the cached one is gone, so a downstream orchestrator can just
 * call it before every inbound frame.
 */
export class RuntimeSessionManager {
  private readonly sessions = new Map<string, ActiveSession>();

  constructor(private readonly opts: RuntimeSessionManagerOptions) {}

  /** Open or reuse the session for one agent. */
  async ensureSession(
    agentId: string,
    metadata: RuntimeSessionMetadata,
  ): Promise<void> {
    const current = this.sessions.get(agentId);
    if (current && current.socket.readyState === RUNTIME_SOCKET_STATE.OPEN) return;

    if (current) await this.closeSession(agentId, "stale_socket");

    const socket = await this.opts.socketFactory(
      metadata.session_endpoint,
      metadata.session_token,
    );

    let resolveReady: () => void = () => {};
    let rejectReady: (err: Error) => void = () => {};
    const ready = new Promise<void>((res, rej) => {
      resolveReady = res;
      rejectReady = rej;
    });

    let resolveClosed: () => void = () => {};
    const closed = new Promise<void>((res) => {
      resolveClosed = res;
    });

    socket.on("open", () => {
      this.opts.log.debug("runtime session open", { agentId });
      resolveReady();
    });

    socket.on("message", (data) => {
      const raw = typeof data === "string" ? data : data?.toString?.() ?? "";
      if (!raw) return;
      let frame: RuntimeOutboundFrame;
      try {
        frame = JSON.parse(raw) as RuntimeOutboundFrame;
      } catch (err) {
        this.opts.log.warn("runtime session bad frame", { agentId, err: String(err) });
        return;
      }
      Promise.resolve(this.opts.hooks.onFrame(agentId, frame)).catch((err) => {
        this.opts.log.error("runtime hook threw", { agentId, err: String(err) });
      });
    });

    socket.on("close", (code, reason) => {
      this.opts.log.info("runtime session closed", { agentId, code, reason: String(reason ?? "") });
      this.sessions.delete(agentId);
      this.opts.hooks.onClose(agentId, `code=${code}`);
      resolveClosed();
    });

    socket.on("error", (err) => {
      this.opts.log.warn("runtime session error", { agentId, err: String(err) });
      rejectReady(err instanceof Error ? err : new Error(String(err)));
    });

    const session: ActiveSession = {
      agentId,
      socket,
      metadata,
      ready,
      closed,
      resolveClosed,
    };
    this.sessions.set(agentId, session);
    // If the socket reports OPEN already (test fakes commonly do), resolve immediately.
    if (socket.readyState === RUNTIME_SOCKET_STATE.OPEN) resolveReady();
    await ready;
  }

  /** Push a `gateway_inbound` frame down the session. */
  async sendInbound(frame: GatewayInboundFrame): Promise<void> {
    const session = this.sessions.get(frame.agent_id);
    if (!session) {
      throw new Error(`no runtime session for ${frame.agent_id}`);
    }
    await session.ready;
    if (session.socket.readyState !== RUNTIME_SOCKET_STATE.OPEN) {
      throw new Error(`runtime session for ${frame.agent_id} is not open`);
    }
    session.socket.send(JSON.stringify(frame));
  }

  hasSession(agentId: string): boolean {
    const s = this.sessions.get(agentId);
    return !!s && s.socket.readyState === RUNTIME_SOCKET_STATE.OPEN;
  }

  async closeSession(agentId: string, reason: string): Promise<void> {
    const session = this.sessions.get(agentId);
    if (!session) return;
    try {
      session.socket.close(1000, reason);
    } catch {
      // ignore
    }
    this.sessions.delete(agentId);
    session.resolveClosed();
  }

  async closeAll(reason: string): Promise<void> {
    for (const id of [...this.sessions.keys()]) {
      await this.closeSession(id, reason);
    }
  }
}
