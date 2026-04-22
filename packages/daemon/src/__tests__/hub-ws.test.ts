import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer, type WebSocket as WsType } from "ws";
import type { AddressInfo } from "node:net";

// Silence the log module — touches ~/.botcord/logs.
vi.mock("../log.js", () => {
  const noop = () => {};
  return { log: { info: noop, warn: noop, error: noop, debug: noop }, LOG_FILE_PATH: "" };
});

const { startHubWs } = await import("../hub-ws.js");
import type { BotCordClient } from "@botcord/protocol-core";

interface Server {
  wss: WebSocketServer;
  url: string;
  close: () => Promise<void>;
  connections: WsType[];
}

async function startServer(handler: (ws: WsType) => void): Promise<Server> {
  const wss = new WebSocketServer({ port: 0, path: "/hub/ws" });
  const connections: WsType[] = [];
  wss.on("connection", (ws) => {
    connections.push(ws);
    handler(ws);
  });
  await new Promise<void>((resolve) => wss.on("listening", () => resolve()));
  const port = (wss.address() as AddressInfo).port;
  return {
    wss,
    connections,
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((resolve) => {
        for (const c of connections) {
          try {
            c.terminate();
          } catch {
            // ignore
          }
        }
        wss.close(() => resolve());
      }),
  };
}

function makeClient(): Pick<BotCordClient, "ensureToken" | "refreshToken"> & {
  ensureToken: ReturnType<typeof vi.fn>;
  refreshToken: ReturnType<typeof vi.fn>;
} {
  return {
    ensureToken: vi.fn().mockResolvedValue("test-token"),
    refreshToken: vi.fn().mockResolvedValue("test-token-2"),
  } as unknown as ReturnType<typeof makeClient>;
}

let server: Server | undefined;
let controllers: AbortController[] = [];

afterEach(async () => {
  for (const c of controllers) c.abort();
  controllers = [];
  if (server) {
    await server.close();
    server = undefined;
  }
});

describe("startHubWs", () => {
  it("does the auth round-trip and fires onInboxUpdate on auth_ok", async () => {
    let receivedAuth: any;
    server = await startServer((ws) => {
      ws.on("message", (raw) => {
        const msg = JSON.parse(String(raw));
        if (msg.type === "auth") {
          receivedAuth = msg;
          ws.send(JSON.stringify({ type: "auth_ok", agent_id: "ag_self" }));
        }
      });
    });

    const client = makeClient();
    const ctrl = new AbortController();
    controllers.push(ctrl);
    const onInboxUpdate = vi.fn().mockResolvedValue(undefined);
    startHubWs({
      client: client as unknown as BotCordClient,
      hubUrl: server.url,
      agentId: "ag_self",
      abortSignal: ctrl.signal,
      onInboxUpdate,
    });

    // Wait for auth handshake + first fireInbox.
    await vi.waitFor(() => {
      expect(receivedAuth?.token).toBe("test-token");
      expect(onInboxUpdate).toHaveBeenCalledTimes(1);
    });
  });

  it("subsequent inbox_update frames trigger another drain with coalescing", async () => {
    server = await startServer((ws) => {
      ws.on("message", (raw) => {
        const msg = JSON.parse(String(raw));
        if (msg.type === "auth") {
          ws.send(JSON.stringify({ type: "auth_ok", agent_id: "ag_self" }));
        }
      });
    });

    const client = makeClient();
    const ctrl = new AbortController();
    controllers.push(ctrl);
    let releaseHandler: () => void = () => {};
    let inFlight = 0;
    let maxInFlight = 0;
    const onInboxUpdate = vi.fn(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise<void>((resolve) => {
        releaseHandler = resolve;
      });
      inFlight -= 1;
    });
    startHubWs({
      client: client as unknown as BotCordClient,
      hubUrl: server.url,
      agentId: "ag_self",
      abortSignal: ctrl.signal,
      onInboxUpdate,
    });

    // Wait for the initial auth_ok-triggered drain.
    await vi.waitFor(() => expect(onInboxUpdate).toHaveBeenCalledTimes(1));
    // Fire two inbox_update frames while the handler is blocked — they should coalesce.
    const conn = server.connections[0];
    conn.send(JSON.stringify({ type: "inbox_update" }));
    conn.send(JSON.stringify({ type: "inbox_update" }));
    await new Promise((r) => setTimeout(r, 20));
    // Release the first handler; coalesced second run should fire.
    releaseHandler();
    await vi.waitFor(() => expect(onInboxUpdate).toHaveBeenCalledTimes(2));
    // Release the coalesced run.
    releaseHandler();
    // Give the loop a tick to settle; make sure no third run was scheduled.
    await new Promise((r) => setTimeout(r, 30));
    expect(onInboxUpdate).toHaveBeenCalledTimes(2);
    expect(maxInFlight).toBe(1);
  });

  it("server close with 4001 triggers refreshToken()", async () => {
    server = await startServer((ws) => {
      ws.on("message", (raw) => {
        const msg = JSON.parse(String(raw));
        if (msg.type === "auth") {
          // Reject with 4001 auth failure.
          ws.close(4001, "auth failed");
        }
      });
    });

    const client = makeClient();
    const ctrl = new AbortController();
    controllers.push(ctrl);
    startHubWs({
      client: client as unknown as BotCordClient,
      hubUrl: server.url,
      agentId: "ag_self",
      abortSignal: ctrl.signal,
      onInboxUpdate: vi.fn(),
    });

    await vi.waitFor(() => expect(client.refreshToken).toHaveBeenCalled());
  });

  it("abortSignal closes the socket cleanly", async () => {
    let connClosed = false;
    server = await startServer((ws) => {
      ws.on("message", (raw) => {
        const msg = JSON.parse(String(raw));
        if (msg.type === "auth") {
          ws.send(JSON.stringify({ type: "auth_ok", agent_id: "ag_self" }));
        }
      });
      ws.on("close", () => {
        connClosed = true;
      });
    });

    const client = makeClient();
    const ctrl = new AbortController();
    controllers.push(ctrl);
    startHubWs({
      client: client as unknown as BotCordClient,
      hubUrl: server.url,
      agentId: "ag_self",
      abortSignal: ctrl.signal,
      onInboxUpdate: vi.fn().mockResolvedValue(undefined),
    });

    // Wait for connection to establish.
    await vi.waitFor(() => expect(server!.connections.length).toBeGreaterThan(0));
    ctrl.abort();
    await vi.waitFor(() => expect(connClosed).toBe(true));
  });
});
