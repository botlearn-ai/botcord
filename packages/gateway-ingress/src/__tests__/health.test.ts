import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";

import { startHealthServer } from "../health.js";
import { noopLogger } from "../log.js";
import type { IngressOrchestrator } from "../orchestrator.js";
import type { ProviderRunner } from "../provider-runner.js";
import { FileSystemIngressStore } from "../storage/store.js";
import type { GatewayConnection } from "../types.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("health server", () => {
  it("includes tracked provider state in /status without internal state", async () => {
    const root = mkdtempSync(join(tmpdir(), "gateway-ingress-health-"));
    tempDirs.push(root);
    const store = new FileSystemIngressStore(root);
    const conn: GatewayConnection = {
      id: "gw_tg_status",
      agentId: "ag_status",
      provider: "telegram",
      status: "active",
      enabled: true,
      config: {},
      createdAt: 1,
      updatedAt: 1,
    };
    store.upsertConnection(conn);
    store.updateState(conn.id, {
      cursor: { offset: 123 },
      dedupe: ["tg:gw_tg_status:122"],
      lastPollAt: 111,
      lastInboundAt: 222,
      lastError: "TypeError: fetch failed for https://api.telegram.org/botsecret-token/getUpdates",
    });

    const runner = {
      isRunning(gatewayId: string) {
        return gatewayId === conn.id;
      },
    } as ProviderRunner;
    const server = await startHealthServer({
      host: "127.0.0.1",
      port: 0,
      log: noopLogger,
      orchestrator: {} as IngressOrchestrator,
      runner,
      store,
    });

    try {
      const res = await fetch(`${server.url}/status`);
      expect(res.status).toBe(200);
      const body = await res.json() as {
        ok: boolean;
        connections: Array<Record<string, unknown>>;
        pending: number;
      };
      expect(body).toEqual({
        ok: true,
        connections: [
          {
            id: "gw_tg_status",
            agentId: "ag_status",
            provider: "telegram",
            status: "active",
            enabled: true,
            running: true,
            lastPollAt: 111,
            lastInboundAt: 222,
            lastError: "Error: fetch_failed",
          },
        ],
        pending: 0,
      });
      expect(JSON.stringify(body)).not.toContain("api.telegram.org");
      expect(JSON.stringify(body)).not.toContain("secret-token");
      expect(JSON.stringify(body)).not.toContain("https://");
      expect(body.connections[0]).not.toHaveProperty("cursor");
      expect(body.connections[0]).not.toHaveProperty("dedupe");
    } finally {
      await server.close();
    }
  });
});
