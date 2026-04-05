/**
 * WebSocket client for real-time BotCord Hub inbox notifications.
 *
 * Protocol:
 *   1. Connect to ws(s)://<hubUrl>/hub/ws
 *   2. Send {"type": "auth", "token": "<JWT>"}
 *   3. Receive {"type": "auth_ok", "agent_id": "ag_xxx"}
 *   4. Receive {"type": "inbox_update"} when new messages arrive
 *   5. On inbox_update → poll /hub/inbox to fetch messages
 *   6. Receive {"type": "heartbeat"} every 30s (keepalive)
 */
import WebSocket from "ws";
import { BotCordClient } from "./client.js";
import { handleInboxMessageBatch } from "./inbound.js";
import { displayPrefix } from "./config.js";
import { buildHubWebSocketUrl } from "./hub-url.js";
import { PLUGIN_VERSION, checkVersionInfo } from "./version-check.js";

interface WsClientOptions {
  client: BotCordClient;
  accountId: string;
  cfg: any;
  abortSignal?: AbortSignal;
  log?: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
}

// Use lazy initialization to avoid TDZ errors when jiti resolves
// the dynamic import("./ws-client.js") before the module body completes.
let _activeWsClients: Map<string, { stop: () => void }> | undefined;
function getActiveWsClients() {
  return (_activeWsClients ??= new Map());
}

// Reconnect backoff: 1s, 2s, 4s, 8s, 16s, 30s max
const RECONNECT_BACKOFF = [1000, 2000, 4000, 8000, 16000, 30000];

export function startWsClient(opts: WsClientOptions): { stop: () => void } {
  // Stop any existing client for this account before creating a new one
  const existing = getActiveWsClients().get(opts.accountId);
  if (existing) existing.stop();

  const { client, accountId, cfg, abortSignal, log } = opts;
  const dp = displayPrefix(accountId, cfg);
  let running = true;
  let ws: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectAttempt = 0;
  let consecutiveAuthFailures = 0;
  const MAX_AUTH_FAILURES = 5;
  let processing = false;
  let pendingUpdate = false;
  let keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  const KEEPALIVE_INTERVAL = 20_000; // 20s — well under Caddy/proxy 30s timeout

  async function fetchAndDispatch() {
    if (processing) {
      // Signal that another fetch is needed after the current one finishes
      pendingUpdate = true;
      return;
    }
    processing = true;
    try {
      do {
        pendingUpdate = false;
        const resp = await client.pollInbox({ limit: 20, ack: false });
        const messages = resp.messages || [];
        try {
          const ackedIds = await handleInboxMessageBatch(messages, accountId, cfg);
          if (ackedIds.length > 0) {
            try {
              await client.ackMessages(ackedIds);
            } catch (err: any) {
              log?.error(`[${dp}] ws ack error: ${err.message}`);
            }
          }
        } catch (err: any) {
          log?.error(`[${dp}] ws batch dispatch error: ${err.message}`);
        }
        // If we got a full batch, there may be more — keep draining
        if (messages.length >= 20) {
          pendingUpdate = true;
        }
      } while (pendingUpdate);
    } catch (err: any) {
      log?.error(`[${dp}] ws poll error: ${err.message}`);
    } finally {
      processing = false;
    }
  }

  async function connect() {
    if (!running || abortSignal?.aborted) return;

    try {
      // Get a fresh JWT token
      const token = await client.ensureToken();
      const hubUrl = client.getHubUrl();
      const wsUrl = buildHubWebSocketUrl(hubUrl);

      log?.info(`[${dp}] WebSocket connecting to ${wsUrl}`);
      ws = new WebSocket(wsUrl);

      ws.on("open", () => {
        // Send auth message with plugin version for Hub version negotiation
        ws!.send(JSON.stringify({ type: "auth", token, plugin_version: PLUGIN_VERSION }));
      });

      ws.on("message", async (data: WebSocket.Data) => {
        try {
          const msg = JSON.parse(data.toString());
          switch (msg.type) {
            case "auth_ok":
              log?.info(`[${dp}] WebSocket authenticated as ${msg.agent_id}`);
              reconnectAttempt = 0; // Reset backoff on successful auth
              consecutiveAuthFailures = 0; // Reset auth failure counter
              // Check Hub's version recommendation — stop if incompatible
              if (checkVersionInfo(msg, log) === "incompatible") {
                log?.error(`[${dp}] Plugin incompatible with Hub, stopping WebSocket`);
                stop();
                return;
              }
              // Start client-side keepalive to survive proxies/Caddy timeouts
              if (keepaliveTimer) clearInterval(keepaliveTimer);
              keepaliveTimer = setInterval(() => {
                if (ws?.readyState === WebSocket.OPEN) {
                  ws.send(JSON.stringify({ type: "ping" }));
                }
              }, KEEPALIVE_INTERVAL);
              // Catch up on messages missed during disconnect
              fetchAndDispatch();
              break;

            case "inbox_update":
              // New messages available — fetch them
              await fetchAndDispatch();
              break;

            case "heartbeat":
              // Respond with ping to keep alive
              ws?.send(JSON.stringify({ type: "ping" }));
              break;

            case "pong":
              // Server responded to our ping
              break;

            default:
              log?.warn(`[${dp}] unknown ws message type: ${msg.type}`);
          }
        } catch (err: any) {
          log?.error(`[${dp}] ws message parse error: ${err.message}`);
        }
      });

      ws.on("close", async (code: number, reason: Buffer) => {
        const reasonStr = reason.toString();
        log?.info(`[${dp}] WebSocket closed: code=${code} reason=${reasonStr}`);
        ws = null;
        if (keepaliveTimer) { clearInterval(keepaliveTimer); keepaliveTimer = null; }

        if (code === 4001) {
          consecutiveAuthFailures++;
          if (consecutiveAuthFailures >= MAX_AUTH_FAILURES) {
            log?.error(`[${dp}] WebSocket auth failed ${consecutiveAuthFailures} times consecutively, stopping reconnect`);
            return;
          }
          log?.warn(`[${dp}] WebSocket auth failed (${consecutiveAuthFailures}/${MAX_AUTH_FAILURES}), force-refreshing token before reconnect`);
          // Await token refresh so the next connect() picks up the new token
          try {
            await client.ensureToken(true);
          } catch (err: any) {
            log?.error(`[${dp}] Token force-refresh failed: ${err.message}`);
          }
        }

        scheduleReconnect();
      });

      ws.on("error", (err: Error) => {
        log?.error(`[${dp}] WebSocket error: ${err.message}`);
        // 'close' event will fire after this, triggering reconnect
      });
    } catch (err: any) {
      log?.error(`[${dp}] WebSocket connect failed: ${err.message}`);
      scheduleReconnect();
    }
  }

  function scheduleReconnect() {
    if (!running || abortSignal?.aborted) return;
    const delay =
      RECONNECT_BACKOFF[Math.min(reconnectAttempt, RECONNECT_BACKOFF.length - 1)];
    reconnectAttempt++;
    log?.info(`[${dp}] WebSocket reconnecting in ${delay}ms (attempt ${reconnectAttempt})`);
    reconnectTimer = setTimeout(connect, delay);
  }

  function stop() {
    running = false;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (keepaliveTimer) { clearInterval(keepaliveTimer); keepaliveTimer = null; }
    if (ws) {
      try {
        ws.close(1000, "client shutdown");
      } catch {
        // ignore
      }
      ws = null;
    }
    getActiveWsClients().delete(accountId);
  }

  // Start connection
  connect();

  const entry = { stop };
  getActiveWsClients().set(accountId, entry);

  abortSignal?.addEventListener("abort", stop, { once: true });

  return entry;
}

export function stopWsClient(accountId: string): void {
  const entry = getActiveWsClients().get(accountId);
  if (entry) entry.stop();
}
