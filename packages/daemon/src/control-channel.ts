/**
 * Daemon ↔ Hub control-plane WebSocket.
 *
 * One long-lived connection, carrying JSON {@link ControlFrame} messages.
 * Independent from the agent data-plane WS: different auth (user access
 * token vs agent JWT), different endpoint (`/daemon/ws`), different
 * lifecycle (alive even when zero agents are bound).
 */
import WebSocket from "ws";
import {
  buildDaemonWebSocketUrl,
  CONTROL_FRAME_TYPES,
  jcsCanonicalize,
  resolveHubControlPublicKey,
  verifyEd25519,
  type ControlAck,
  type ControlFrame,
} from "@botcord/protocol-core";
import { log as daemonLog } from "./log.js";
import {
  AuthRefreshRejectedError,
  writeAuthExpiredFlag,
  type UserAuthManager,
} from "./user-auth.js";

/** Exponential backoff plan for transient disconnects. */
const RECONNECT_BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 30000];
/**
 * Keepalive cadence. Has to stay below the smallest idle-timeout in any
 * intermediary on the daemon → Hub WS path. Cloudflare and AWS ALB both
 * default to ~60s of idle without app-level data, and some tunnels strip
 * WS-level ping/pong control frames entirely — hence we send an app-level
 * `pong` heartbeat alongside `ws.ping()` rather than relying on it alone.
 */
const KEEPALIVE_INTERVAL_MS = 20_000;
const REPLAY_DEDUPE_CAP = 256;

/**
 * Build the canonical signing input for a control frame: RFC 8785 (JCS)
 * canonicalization of `{id, type, params, ts}`. The Hub uses Python
 * `jcs.canonicalize` over the same object before signing.
 *
 * Excludes `sig` by definition. `params` defaults to `{}` (empty object)
 * to match the Hub-side default for paramless types like `ping`.
 */
export function controlSigningInput(
  frame: { id: string; type: string; ts?: number; params?: unknown },
): string {
  const obj = {
    id: frame.id,
    type: frame.type,
    params: (frame.params ?? {}) as Record<string, unknown>,
    ts: typeof frame.ts === "number" ? frame.ts : 0,
  };
  return jcsCanonicalize(obj) ?? "{}";
}

/** Handler invoked for each inbound frame. Return value is the ack payload. */
export type ControlFrameHandler = (
  frame: ControlFrame,
) => Promise<Omit<ControlAck, "id"> | void> | Omit<ControlAck, "id"> | void;

/** Options accepted by {@link ControlChannel}. */
export interface ControlChannelOptions {
  /** User-auth manager driving the access token. */
  auth: UserAuthManager;
  /** Dispatcher for inbound frames. Unknown types should return an error ack. */
  handle: ControlFrameHandler;
  /** Override the WS endpoint path; defaults to `/daemon/ws`. */
  path?: string;
  /**
   * Optional human label sent to Hub on connect (`?label=...`). Hub uses it
   * to populate `daemon_instances.label` for the dashboard listing. Plan §11.3.
   */
  label?: string;
  /**
   * Override the embedded Hub control-plane public key (raw 32-byte, base64).
   * When omitted the channel falls back to {@link resolveHubControlPublicKey},
   * which honors `BOTCORD_HUB_CONTROL_PUBLIC_KEY`.
   */
  hubPublicKey?: string | null;
  /** Test hook — inject a WebSocket constructor. */
  webSocketCtor?: typeof WebSocket;
  /** Test hook — override the backoff schedule. */
  backoffMs?: number[];
  /** Test hook — override the keepalive interval. */
  keepaliveIntervalMs?: number;
}

/**
 * Long-lived, self-healing WS connection that carries control frames
 * between the Hub and the local daemon. Owns reconnect/backoff and
 * dedupe; delegates frame semantics to a caller-supplied handler.
 */
export class ControlChannel {
  private readonly auth: UserAuthManager;
  private readonly handle: ControlFrameHandler;
  private readonly path: string;
  private readonly label: string | undefined;
  private readonly hubPublicKey: string | null;
  private readonly webSocketCtor: typeof WebSocket;
  private readonly backoff: number[];
  private readonly keepaliveMs: number;

  private ws: WebSocket | null = null;
  private stopRequested = false;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  private readonly seenFrameIds: string[] = [];
  private connectInflight: Promise<void> | null = null;
  private connected = false;

  constructor(opts: ControlChannelOptions) {
    this.auth = opts.auth;
    this.handle = opts.handle;
    this.path = opts.path ?? "/daemon/ws";
    // Prefer an explicit `label` from start-time; fall back to whatever
    // was persisted on the user-auth record at login.
    this.label = opts.label ?? opts.auth.current?.label;
    this.hubPublicKey =
      opts.hubPublicKey === undefined ? resolveHubControlPublicKey() : opts.hubPublicKey;
    this.webSocketCtor = opts.webSocketCtor ?? WebSocket;
    this.backoff = opts.backoffMs ?? RECONNECT_BACKOFF_MS;
    this.keepaliveMs = opts.keepaliveIntervalMs ?? KEEPALIVE_INTERVAL_MS;
  }

  /** True once the initial WS handshake succeeded. Flipped back on close. */
  get isConnected(): boolean {
    return this.connected;
  }

  /**
   * Open the WS. Resolves after the first `open` event — transient
   * reconnects after that run in the background until `stop()` is
   * called. Throws immediately if no user-auth record is loaded.
   */
  async start(): Promise<void> {
    if (!this.auth.current) {
      throw new Error("control-channel requires user-auth; run `botcord-daemon start`");
    }
    if (this.connectInflight) return this.connectInflight;
    this.stopRequested = false;
    daemonLog.info("control-channel starting", {
      userId: this.auth.current.userId,
      hubUrl: this.auth.current.hubUrl,
      path: this.path,
      label: this.label ?? null,
      hubKeyConfigured: !!this.hubPublicKey,
    });
    this.connectInflight = this.connect().catch((err) => {
      // Initial connect failure surfaces to the caller; subsequent
      // reconnects are handled opaquely inside onClose. A refresh-rejected
      // error means the refresh token itself is dead — no point retrying;
      // writeAuthExpiredFlag was already called in user-auth.refresh().
      if (err instanceof AuthRefreshRejectedError) {
        this.stopRequested = true;
        daemonLog.warn("control-channel: refresh rejected; stopping (re-login required)", {
          status: err.status,
        });
      } else {
        this.scheduleReconnect(err);
      }
      throw err;
    });
    try {
      await this.connectInflight;
    } finally {
      this.connectInflight = null;
    }
  }

  /** Close the WS and stop reconnecting. Idempotent. */
  async stop(): Promise<void> {
    if (!this.stopRequested) {
      daemonLog.info("control-channel stopping", { wasConnected: this.connected });
    }
    this.stopRequested = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopKeepalive();
    const ws = this.ws;
    this.ws = null;
    this.connected = false;
    if (ws) {
      try {
        ws.close(1000, "daemon stopping");
      } catch {
        // ignore
      }
    }
  }

  /** Actively send a frame (used for event reports like `agent_provisioned`). */
  send(frame: ControlFrame): boolean {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      daemonLog.debug("control-channel.send skipped (not open)", {
        type: frame.type,
        id: frame.id,
        readyState: ws?.readyState ?? null,
      });
      return false;
    }
    try {
      ws.send(JSON.stringify(frame));
      daemonLog.debug("control-channel.send", { type: frame.type, id: frame.id });
      return true;
    } catch (err) {
      daemonLog.warn("control-channel.send failed", {
        type: frame.type,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  private async connect(): Promise<void> {
    const record = this.auth.current;
    if (!record) throw new Error("control-channel: no user-auth");

    const accessToken = await this.auth.ensureAccessToken();
    const url = buildDaemonWebSocketUrl(
      record.hubUrl,
      this.path,
      this.label ? { label: this.label } : undefined,
    );
    daemonLog.info("control-channel connecting", { url });

    const ws = new this.webSocketCtor(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    this.ws = ws;

    await new Promise<void>((resolve, reject) => {
      const onOpen = (): void => {
        ws.removeListener("error", onError);
        this.connected = true;
        this.reconnectAttempts = 0;
        daemonLog.info("control-channel connected", { url });
        this.startKeepalive();
        resolve();
      };
      const onError = (err: Error): void => {
        ws.removeListener("open", onOpen);
        reject(err);
      };
      ws.once("open", onOpen);
      ws.once("error", onError);
    });

    ws.on("message", (data) => this.onMessage(data));
    ws.on("close", (code, reason) => this.onClose(code, reason));
    ws.on("error", (err) =>
      daemonLog.warn("control-channel error", {
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }

  private startKeepalive(): void {
    this.stopKeepalive();
    this.keepaliveTimer = setInterval(() => {
      const ws = this.ws;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      // WS-level ping for normal cases.
      try {
        ws.ping();
      } catch {
        // ignore — next failed send will trigger close
      }
      // App-level heartbeat: a `pong` daemon-initiated frame. Hub recognizes
      // it via `_DAEMON_INITIATED_TYPES` and bumps `last_seen_at`. Critical
      // when an intermediary (Cloudflare, AWS ALB, some k8s ingresses)
      // drops WS-level control frames — those proxies idle-close the WS at
      // ~60s without app-level activity, masquerading as a clean 1006 to
      // both peers.
      this.send({
        id: `hb_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        type: "pong",
        ts: Date.now(),
      });
    }, this.keepaliveMs);
  }

  private stopKeepalive(): void {
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
  }

  private onClose(code: number, reason: Buffer): void {
    const reasonText = reason?.toString() || "";
    this.connected = false;
    this.stopKeepalive();
    this.ws = null;
    daemonLog.info("control-channel closed", { code, reason: reasonText });

    // 4401 / 4403 = auth problem per the plan. Surface via the flag file
    // and stop reconnecting; the daemon is now in a "needs re-login" state.
    if (code === 4401 || code === 4403 || code === 1008) {
      daemonLog.warn("control-channel auth rejected; marking auth expired", { code });
      writeAuthExpiredFlag();
      this.stopRequested = true;
      return;
    }

    if (this.stopRequested) return;
    this.scheduleReconnect();
  }

  private scheduleReconnect(err?: unknown): void {
    if (this.stopRequested) return;
    if (err instanceof AuthRefreshRejectedError) {
      this.stopRequested = true;
      daemonLog.warn("control-channel: refresh rejected; halting reconnect (re-login required)", {
        status: err.status,
      });
      return;
    }
    const attempt = this.reconnectAttempts;
    this.reconnectAttempts = attempt + 1;
    const delay = this.backoff[Math.min(attempt, this.backoff.length - 1)];
    if (err) {
      daemonLog.warn("control-channel reconnect scheduled", {
        delayMs: delay,
        error: err instanceof Error ? err.message : String(err),
      });
    } else {
      daemonLog.info("control-channel reconnect scheduled", { delayMs: delay });
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.stopRequested) return;
      this.connect().catch((err) => this.scheduleReconnect(err));
    }, delay);
  }

  private async onMessage(data: WebSocket.RawData): Promise<void> {
    let frame: ControlFrame;
    try {
      frame = JSON.parse(data.toString()) as ControlFrame;
    } catch (err) {
      daemonLog.warn("control-channel: non-JSON frame", {
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    if (!frame || typeof frame.id !== "string" || typeof frame.type !== "string") {
      // Hub ack responses for daemon-initiated frames (runtime_snapshot push,
      // heartbeat, etc.) carry `{id, ok}` and no `type`. They're expected,
      // not malformed — drop silently. Anything else stays a warn.
      if (
        frame &&
        typeof (frame as { id?: unknown }).id === "string" &&
        typeof (frame as { ok?: unknown }).ok === "boolean"
      ) {
        return;
      }
      daemonLog.warn("control-channel: malformed frame", { frame });
      return;
    }

    // Replay-window check: Hub-signed frames carry `ts`; absent on pong
    // responses, so skip the check when not present.
    if (typeof frame.ts === "number") {
      const skewMs = Math.abs(Date.now() - frame.ts);
      if (skewMs > 5 * 60 * 1000) {
        daemonLog.warn("control-channel: rejecting frame with stale ts", {
          type: frame.type,
          id: frame.id,
          skewMs,
        });
        this.sendAck({
          id: frame.id,
          ok: false,
          error: { code: "stale_ts", message: `timestamp skew ${skewMs}ms exceeds window` },
        });
        return;
      }
    }

    // Hub→daemon signature check. Plan §8.3 mandates rejection of unsigned
    // frames once a Hub key is configured. When no key is available (P1
    // dev / placeholder constant), we log a warning per frame and accept,
    // so the daemon can still bring up the control plane against a Hub
    // that hasn't published its key yet.
    if (this.hubPublicKey) {
      if (typeof frame.sig !== "string" || frame.sig.length === 0) {
        daemonLog.warn("control-channel: rejecting unsigned frame", {
          type: frame.type,
          id: frame.id,
        });
        this.sendAck({
          id: frame.id,
          ok: false,
          error: { code: "unsigned", message: "hub signature required" },
        });
        return;
      }
      if (!verifyEd25519(this.hubPublicKey, controlSigningInput(frame), frame.sig)) {
        daemonLog.warn("control-channel: rejecting frame with bad signature", {
          type: frame.type,
          id: frame.id,
        });
        this.sendAck({
          id: frame.id,
          ok: false,
          error: { code: "bad_signature", message: "hub signature did not verify" },
        });
        return;
      }
    } else if (typeof frame.sig === "string") {
      // Key not configured yet; skip verification but warn loudly.
      daemonLog.warn(
        "control-channel: skipping signature verification (no Hub public key configured)",
        { type: frame.type, id: frame.id },
      );
    }

    // Idempotent dedupe: replay the cached result would require storing
    // past results — for P0 we just ack the dup with a no-op ok. The
    // provisioner itself is the authoritative dedupe boundary for
    // stateful operations.
    if (this.seenFrameIds.includes(frame.id)) {
      daemonLog.debug("control-channel: duplicate frame, acking as no-op", {
        type: frame.type,
        id: frame.id,
      });
      this.sendAck({ id: frame.id, ok: true, result: { duplicate: true } });
      return;
    }
    this.seenFrameIds.push(frame.id);
    if (this.seenFrameIds.length > REPLAY_DEDUPE_CAP) {
      this.seenFrameIds.splice(0, this.seenFrameIds.length - REPLAY_DEDUPE_CAP);
    }

    daemonLog.debug("control-channel frame received", {
      type: frame.type,
      id: frame.id,
    });

    // Plan §6.3 — instance-level revoke: write the expired flag, ack, and
    // tear down the control plane. Agent gateway stays up so existing
    // agent tokens keep working until the operator re-authorizes.
    if (frame.type === CONTROL_FRAME_TYPES.REVOKE) {
      writeAuthExpiredFlag();
      const reason =
        frame.params && typeof (frame.params as { reason?: unknown }).reason === "string"
          ? ((frame.params as { reason?: string }).reason as string)
          : "revoked_by_hub";
      daemonLog.warn("control-channel: instance revoked by hub", { reason });
      this.sendAck({ id: frame.id, ok: true, result: { acknowledged: true } });
      void this.stop();
      return;
    }

    try {
      const result = await this.handle(frame);
      const ack: ControlAck = result
        ? { id: frame.id, ...result }
        : { id: frame.id, ok: true };
      daemonLog.debug("control-channel handler done", {
        type: frame.type,
        id: frame.id,
        ok: ack.ok !== false,
      });
      this.sendAck(ack);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      daemonLog.error("control-channel handler failed", {
        type: frame.type,
        error: message,
      });
      this.sendAck({
        id: frame.id,
        ok: false,
        error: { code: "handler_error", message },
      });
    }
  }

  private sendAck(ack: ControlAck): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify(ack));
    } catch (err) {
      daemonLog.warn("control-channel.ack failed", {
        id: ack.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
