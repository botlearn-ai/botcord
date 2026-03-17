/**
 * Lightweight mock Hub server for integration tests.
 * Simulates key Hub API endpoints with in-memory state.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface MockHubState {
  /** Sent messages stored here */
  messages: Array<{ envelope: any; topic?: string }>;
  /** Messages queued for inbox poll */
  inbox: any[];
  /** Registered endpoints */
  endpoints: Array<{ url: string; webhook_token?: string }>;
  /** Rooms */
  rooms: any[];
  /** Contacts */
  contacts: any[];
  /** Token refresh call count (for testing retry/re-auth) */
  tokenRefreshCount: number;
  /** Custom response overrides by path pattern */
  overrides: Map<string, { status: number; body: any; headers?: Record<string, string> }>;
}

function parseBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString()));
      } catch {
        resolve({});
      }
    });
    req.on("error", reject);
  });
}

export function createMockHub() {
  const state: MockHubState = {
    messages: [],
    inbox: [],
    endpoints: [],
    rooms: [],
    contacts: [],
    tokenRefreshCount: 0,
    overrides: new Map(),
  };

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url || "/", "http://localhost");
    const path = url.pathname;
    const method = req.method || "GET";

    // Check for overrides first
    for (const [pattern, override] of state.overrides) {
      if (path.includes(pattern)) {
        res.writeHead(override.status, {
          "Content-Type": "application/json",
          ...(override.headers || {}),
        });
        res.end(JSON.stringify(override.body));
        return;
      }
    }

    // ── Token refresh ──────────────────────────────────────────
    if (path.includes("/token/refresh") && method === "POST") {
      state.tokenRefreshCount++;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        token: `mock-jwt-token-${state.tokenRefreshCount}`,
        expires_at: Math.floor(Date.now() / 1000) + 86400,
      }));
      return;
    }

    // ── Send message ───────────────────────────────────────────
    if (path === "/hub/send" && method === "POST") {
      const body = await parseBody(req);
      const topic = url.searchParams.get("topic") || undefined;
      state.messages.push({ envelope: body, topic });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        queued: true,
        hub_msg_id: `hub_${Date.now()}`,
        status: "queued",
      }));
      return;
    }

    // ── Poll inbox ─────────────────────────────────────────────
    if (path === "/hub/inbox" && method === "GET") {
      const limit = parseInt(url.searchParams.get("limit") || "20", 10);
      const ack = url.searchParams.get("ack") === "true";
      const msgs = state.inbox.slice(0, limit);
      if (ack) state.inbox.splice(0, msgs.length);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        messages: msgs,
        count: msgs.length,
        has_more: state.inbox.length > msgs.length,
      }));
      return;
    }

    // ── History ────────────────────────────────────────────────
    if (path === "/hub/history" && method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ messages: state.messages.map((m) => m.envelope) }));
      return;
    }

    // ── Resolve agent ──────────────────────────────────────────
    if (path.startsWith("/registry/resolve/") && method === "GET") {
      const agentId = path.split("/").pop()!;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        agent_id: agentId,
        display_name: `Agent ${agentId}`,
        bio: "mock agent",
        message_policy: "open",
        endpoints: [],
      }));
      return;
    }

    // ── Register endpoint ──────────────────────────────────────
    if (path.includes("/endpoints") && method === "POST") {
      const body = await parseBody(req);
      state.endpoints.push(body);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // ── Contacts ───────────────────────────────────────────────
    if (path.includes("/contacts") && method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(state.contacts));
      return;
    }

    // ── Rooms ──────────────────────────────────────────────────
    if (path === "/hub/rooms" && method === "POST") {
      const body = await parseBody(req);
      const room = {
        room_id: `rm_${Date.now()}`,
        name: body.name,
        description: body.description || "",
        visibility: body.visibility || "private",
        join_policy: body.join_policy || "invite_only",
        default_send: body.default_send ?? true,
        member_count: 1,
        created_at: new Date().toISOString(),
      };
      state.rooms.push(room);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(room));
      return;
    }

    if (path === "/hub/rooms/me" && method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(state.rooms));
      return;
    }

    if (path.startsWith("/hub/rooms/rm_") && method === "GET") {
      const roomId = path.split("/").pop()!;
      const room = state.rooms.find((r) => r.room_id === roomId);
      if (room) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ...room, members: [] }));
      } else {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
      }
      return;
    }

    // ── Blocks ─────────────────────────────────────────────────
    if (path.includes("/blocks") && method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify([]));
      return;
    }

    // ── Contact requests ───────────────────────────────────────
    if (path.includes("/contact-requests/") && method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify([]));
      return;
    }

    if (path.includes("/accept") || path.includes("/reject")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // ── Fallback ───────────────────────────────────────────────
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found", path }));
  });

  return {
    state,
    /** Start the server on a random port, returns the base URL */
    async start(): Promise<string> {
      return new Promise((resolve) => {
        server.listen(0, "127.0.0.1", () => {
          const { port } = server.address() as AddressInfo;
          resolve(`http://127.0.0.1:${port}`);
        });
      });
    },
    async stop(): Promise<void> {
      return new Promise((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}
