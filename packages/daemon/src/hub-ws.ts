import WebSocket from "ws";
import { buildHubWebSocketUrl, type BotCordClient } from "@botcord/protocol-core";
import { log } from "./log.js";

const RECONNECT_BACKOFF = [1000, 2000, 4000, 8000, 16000, 30000];
const KEEPALIVE_INTERVAL = 20_000;
const MAX_AUTH_FAILURES = 5;

export type WsStatus = "disconnected" | "connecting" | "authenticated" | "reconnecting";

export interface HubWsOptions {
  client: BotCordClient;
  hubUrl: string;
  agentId: string;
  onInboxUpdate: () => void | Promise<void>;
  abortSignal: AbortSignal;
}

/**
 * Connects to /hub/ws, authenticates with JWT, and fires `onInboxUpdate` on every
 * `inbox_update` frame. Exponential backoff on disconnect; token refresh on 4001.
 *
 * Ported from plugin/src/ws-client.ts, stripped of OpenClaw-specific wiring.
 */
export function startHubWs(opts: HubWsOptions): { stop: () => void; getStatus: () => WsStatus } {
  const { client, hubUrl, agentId, onInboxUpdate, abortSignal } = opts;
  let ws: WebSocket | null = null;
  let status: WsStatus = "connecting";
  let reconnectTimer: NodeJS.Timeout | null = null;
  let keepaliveTimer: NodeJS.Timeout | null = null;
  let reconnectAttempt = 0;
  let consecutiveAuthFailures = 0;
  let running = true;
  let processing = false;
  let pendingUpdate = false;
  let pendingRefresh: Promise<unknown> | null = null;

  abortSignal.addEventListener("abort", () => stop(), { once: true });

  async function fireInbox() {
    if (processing) {
      pendingUpdate = true;
      return;
    }
    processing = true;
    try {
      do {
        pendingUpdate = false;
        await onInboxUpdate();
      } while (pendingUpdate && running);
    } catch (err) {
      log.error("inbox handler failed", { err: String(err) });
    } finally {
      processing = false;
    }
  }

  function clearTimers() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (keepaliveTimer) {
      clearInterval(keepaliveTimer);
      keepaliveTimer = null;
    }
  }

  function scheduleReconnect() {
    if (!running) return;
    const delay =
      RECONNECT_BACKOFF[Math.min(reconnectAttempt, RECONNECT_BACKOFF.length - 1)];
    reconnectAttempt += 1;
    status = "reconnecting";
    log.info("ws reconnect scheduled", { delayMs: delay, attempt: reconnectAttempt });
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  async function connect() {
    if (!running) return;
    status = "connecting";
    // If a 4001 triggered an in-flight refresh, wait for it so we don't reconnect
    // with the stale token that server just rejected.
    if (pendingRefresh) {
      try {
        await pendingRefresh;
      } catch {
        // Errors already logged by the scheduler; fall through to ensureToken which may retry.
      } finally {
        pendingRefresh = null;
      }
    }
    let token: string;
    try {
      token = await client.ensureToken();
    } catch (err) {
      log.error("ws token refresh failed", { err: String(err) });
      scheduleReconnect();
      return;
    }

    const url = buildHubWebSocketUrl(hubUrl);
    log.info("ws connecting", { url, agentId });

    try {
      ws = new WebSocket(url);
    } catch (err) {
      log.error("ws construct failed", { err: String(err) });
      scheduleReconnect();
      return;
    }

    ws.on("open", () => {
      ws!.send(JSON.stringify({ type: "auth", token }));
    });

    ws.on("message", (data) => {
      let msg: any;
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }
      if (msg.type === "auth_ok") {
        status = "authenticated";
        reconnectAttempt = 0;
        consecutiveAuthFailures = 0;
        log.info("ws authenticated", { agentId: msg.agent_id });
        // Fire once on (re)connect to drain anything queued while we were offline.
        fireInbox();
        keepaliveTimer = setInterval(() => {
          if (ws && ws.readyState === WebSocket.OPEN) {
            try {
              ws.send(JSON.stringify({ type: "ping" }));
            } catch {
              // ignore
            }
          }
        }, KEEPALIVE_INTERVAL);
      } else if (msg.type === "inbox_update") {
        log.info("ws inbox_update received");
        fireInbox();
      } else if (msg.type === "heartbeat" || msg.type === "pong") {
        // no-op
      } else if (msg.type === "error" || msg.type === "auth_failed") {
        log.warn("ws server error", { msg });
      }
    });

    ws.on("close", (code, reason) => {
      const reasonStr = reason?.toString() || "";
      log.info("ws closed", { code, reason: reasonStr });
      clearTimers();
      if (code === 4001) {
        consecutiveAuthFailures += 1;
        if (consecutiveAuthFailures >= MAX_AUTH_FAILURES) {
          log.error("ws auth failing persistently — giving up reconnects", {
            failures: consecutiveAuthFailures,
          });
          running = false;
          status = "disconnected";
          return;
        }
        // Force a token refresh; connect() will await this before dialing.
        pendingRefresh = client
          .refreshToken()
          .catch((err) => log.error("ws forced refresh failed", { err: String(err) }));
      }
      scheduleReconnect();
    });

    ws.on("error", (err) => {
      log.warn("ws error", { err: String(err) });
      // The `close` event follows and handles reconnect.
    });
  }

  function stop() {
    running = false;
    status = "disconnected";
    clearTimers();
    if (ws) {
      try {
        ws.close();
      } catch {
        // ignore
      }
      ws = null;
    }
  }

  connect();

  return { stop, getStatus: () => status };
}
