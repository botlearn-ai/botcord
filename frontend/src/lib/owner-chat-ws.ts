/**
 * Owner-chat WebSocket client.
 * Connects to Hub's /dashboard/chat/ws for real-time messaging
 * and execution block streaming.
 */
import type { OwnerChatWsMessage, OwnerChatNotification, StreamBlockEntry } from "./types";

export interface OwnerChatWsOptions {
  hubBaseUrl: string;
  getToken: () => Promise<string>;
  agentId: string;
  onMessage: (msg: OwnerChatWsMessage) => void;
  onStreamBlock: (block: StreamBlockEntry) => void;
  onTyping?: () => void;
  onNotification?: (notif: OwnerChatNotification) => void;
  onAuthOk: (data: { agent_id: string; room_id: string }) => void;
  onStatusChange?: (connected: boolean) => void;
  onSendFailed?: (text: string, clientMsgId?: string) => void;
}

export interface WsAttachment {
  filename: string;
  url: string;
  content_type?: string;
  size_bytes?: number;
}

export interface OwnerChatWsClient {
  send: (text: string, attachments?: WsAttachment[], clientMsgId?: string) => boolean;
  close: () => void;
}

const RECONNECT_DELAYS = [1000, 2000, 4000, 8000, 16000, 30000];

const KEEPALIVE_INTERVAL = 20_000; // 20s — match plugin ws-client keepalive

export function createOwnerChatWs(opts: OwnerChatWsOptions): OwnerChatWsClient {
  let ws: WebSocket | null = null;
  let closed = false;
  let reconnectAttempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  let authenticated = false;

  function buildWsUrl(): string {
    const base = opts.hubBaseUrl
      .replace(/^http:/, "ws:")
      .replace(/^https:/, "wss:")
      .replace(/\/$/, "");
    return `${base}/dashboard/chat/ws`;
  }

  async function connect() {
    if (closed) return;

    try {
      const url = buildWsUrl();
      ws = new WebSocket(url);
      authenticated = false;

      ws.onopen = async () => {
        try {
          const token = await opts.getToken();
          ws?.send(JSON.stringify({
            type: "auth",
            token,
            agent_id: opts.agentId,
          }));
        } catch (err) {
          console.error("[owner-chat-ws] Failed to get token for auth:", err);
          ws?.close();
        }
      };

      ws.onmessage = (event) => {
        let data: any;
        try {
          data = JSON.parse(event.data);
        } catch {
          return;
        }

        switch (data.type) {
          case "auth_ok":
            authenticated = true;
            reconnectAttempt = 0;
            // Start client-side keepalive to survive proxy/ALB idle timeouts
            if (keepaliveTimer) clearInterval(keepaliveTimer);
            keepaliveTimer = setInterval(() => {
              if (ws?.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: "ping" }));
              }
            }, KEEPALIVE_INTERVAL);
            opts.onAuthOk({ agent_id: data.agent_id, room_id: data.room_id });
            opts.onStatusChange?.(true);
            break;

          case "message":
            opts.onMessage(data as OwnerChatWsMessage);
            break;

          case "stream_block":
            opts.onStreamBlock(data as StreamBlockEntry);
            break;

          case "typing":
            opts.onTyping?.();
            break;

          case "notification":
            opts.onNotification?.(data as OwnerChatNotification);
            break;

          case "heartbeat":
          case "pong":
            // keepalive, no action needed
            break;

          case "error":
            console.warn("[owner-chat-ws] Server error:", data.message);
            // Server rejected a send — notify caller so pending msg can be marked failed
            opts.onSendFailed?.(data.message || "Server error", data.client_msg_id);
            break;
        }
      };

      ws.onclose = () => {
        authenticated = false;
        if (keepaliveTimer) { clearInterval(keepaliveTimer); keepaliveTimer = null; }
        opts.onStatusChange?.(false);
        if (!closed) {
          scheduleReconnect();
        }
      };

      ws.onerror = (err) => {
        console.warn("[owner-chat-ws] WebSocket error:", err);
      };
    } catch (err) {
      console.error("[owner-chat-ws] Connection failed:", err);
      if (!closed) {
        scheduleReconnect();
      }
    }
  }

  function scheduleReconnect() {
    if (closed || reconnectTimer) return;
    const delay = RECONNECT_DELAYS[Math.min(reconnectAttempt, RECONNECT_DELAYS.length - 1)];
    reconnectAttempt++;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connect();
    }, delay);
  }

  function send(text: string, attachments?: WsAttachment[], clientMsgId?: string): boolean {
    if (!ws || !authenticated || ws.readyState !== WebSocket.OPEN) {
      opts.onSendFailed?.(text, clientMsgId);
      return false;
    }
    try {
      const msg: Record<string, unknown> = { type: "send", text };
      if (attachments && attachments.length > 0) {
        msg.attachments = attachments;
      }
      if (clientMsgId) {
        msg.client_msg_id = clientMsgId;
      }
      ws.send(JSON.stringify(msg));
      return true;
    } catch {
      opts.onSendFailed?.(text, clientMsgId);
      return false;
    }
  }

  function close() {
    closed = true;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (keepaliveTimer) {
      clearInterval(keepaliveTimer);
      keepaliveTimer = null;
    }
    if (ws) {
      ws.onclose = null;
      ws.close();
      ws = null;
    }
    opts.onStatusChange?.(false);
  }

  // Start connection
  void connect();

  return { send, close };
}
