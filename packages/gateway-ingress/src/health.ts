import { createServer, type Server } from "node:http";

import type { IngressLogger } from "./log.js";
import { safeObservableStatusError } from "./observable-error.js";
import type { IngressOrchestrator } from "./orchestrator.js";
import type { ProviderRunner } from "./provider-runner.js";
import type { IngressStore } from "./storage/store.js";

export interface HealthServerOptions {
  host: string;
  port: number;
  log: IngressLogger;
  orchestrator: IngressOrchestrator;
  runner: ProviderRunner;
  store: IngressStore;
}

export interface HealthServer {
  url: string;
  close(): Promise<void>;
}

/**
 * Tiny HTTP server exposing `/healthz` (liveness) and `/status`
 * (snapshot of connections + queue depth). Returning `port = 0` from
 * `loadConfigFromEnv` disables this — useful for non-managed
 * deployments and tests.
 */
export async function startHealthServer(opts: HealthServerOptions): Promise<HealthServer> {
  const server: Server = createServer((req, res) => {
    if (req.url === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.url === "/status") {
      const conns = opts.store.listConnections().map((c) => {
        const state = opts.store.getState(c.id);
        return {
          id: c.id,
          agentId: c.agentId,
          provider: c.provider,
          status: c.status,
          enabled: c.enabled,
          running: opts.runner.isRunning(c.id),
          ...(Number.isFinite(state?.lastPollAt) ? { lastPollAt: state!.lastPollAt } : {}),
          ...(Number.isFinite(state?.lastInboundAt) ? { lastInboundAt: state!.lastInboundAt } : {}),
          ...(typeof state?.lastError === "string" || state?.lastError === null
            ? { lastError: safeObservableStatusError(state.lastError) }
            : {}),
        };
      });
      const queued = opts.store.listEventsByStatus("queued", "delivering").length;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, connections: conns, pending: queued }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const url = await new Promise<string>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, opts.host, () => {
      const addr = server.address();
      if (addr && typeof addr === "object") {
        resolve(`http://${opts.host}:${addr.port}`);
      } else {
        resolve(`http://${opts.host}:${opts.port}`);
      }
    });
  });

  opts.log.info("ingress health server", { url });

  return {
    url,
    async close(): Promise<void> {
      await new Promise<void>((res) => server.close(() => res()));
    },
  };
}
