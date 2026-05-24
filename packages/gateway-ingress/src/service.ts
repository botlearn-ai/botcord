import type { IngressConfig } from "./config.js";
import { createHubClient } from "./hub-client.js";
import type { HubClient } from "./hub-client.js";
import { startHealthServer, type HealthServer } from "./health.js";
import { consoleLogger, type IngressLogger } from "./log.js";
import { IngressOrchestrator } from "./orchestrator.js";
import { ProviderRunner } from "./provider-runner.js";
import { DEFAULT_PROVIDER_FACTORIES } from "./providers/registry.js";
import type { ProviderAdapterFactory } from "./providers/types.js";
import { RuntimeSessionManager, RUNTIME_SOCKET_STATE, type RuntimeSocketFactory } from "./runtime/session.js";
import { FileSecretStore, type IngressSecretStore } from "./storage/secrets.js";
import { FileSystemIngressStore, type IngressStore } from "./storage/store.js";

/**
 * Constructable bundle wiring every ingress subsystem. Used by the CLI
 * and by tests — the CLI passes env-derived config; tests inject a
 * memory store + fake hub + fake socket factory.
 */
export interface IngressService {
  store: IngressStore;
  secrets: IngressSecretStore;
  hub: HubClient;
  runtime: RuntimeSessionManager;
  orchestrator: IngressOrchestrator;
  runner: ProviderRunner;
  health: HealthServer | null;
  config: IngressConfig;
  log: IngressLogger;
  shutdown(reason?: string): Promise<void>;
}

export interface BuildIngressOptions {
  config: IngressConfig;
  log?: IngressLogger;
  store?: IngressStore;
  secrets?: IngressSecretStore;
  hub?: HubClient;
  socketFactory?: RuntimeSocketFactory;
  factories?: Record<string, ProviderAdapterFactory>;
  /** Start the HTTP health server. Defaults to true when `config.healthPort > 0`. */
  startHealth?: boolean;
}

/** Construct the service graph without starting any provider loops. */
export async function buildIngressService(
  opts: BuildIngressOptions,
): Promise<IngressService> {
  const log = opts.log ?? consoleLogger;
  const store = opts.store ?? new FileSystemIngressStore(opts.config.dataDir);
  const secrets = opts.secrets ?? new FileSecretStore(opts.config.secretDir);
  const hub =
    opts.hub ??
    createHubClient({
      baseUrl: opts.config.hubUrl,
      ingressSecret: opts.config.ingressSecret,
      ...(opts.config.runtimeEndpointOverride
        ? { runtimeEndpointOverride: opts.config.runtimeEndpointOverride }
        : {}),
    });

  const socketFactory =
    opts.socketFactory ??
    (async (endpoint, token) => {
      // Lazy import so dependency-free unit tests don't pull `ws`.
      const { WebSocket } = await import("ws");
      const socket = new WebSocket(endpoint, {
        headers: { Authorization: `Bearer ${token}` },
      });
      return socket as unknown as Parameters<RuntimeSocketFactory>[0] extends string
        ? never
        : {
            readyState: number;
            send(data: string): void;
            close(code?: number, reason?: string): void;
            on: (...args: unknown[]) => unknown;
          };
    });

  const orchestrator = new IngressOrchestrator({
    store,
    hub,
    log,
    runtime: undefined as unknown as RuntimeSessionManager,
    dedupeCapacity: opts.config.dedupeCapacity,
  });

  const runtime = new RuntimeSessionManager({
    socketFactory,
    log,
    hooks: {
      onFrame: (agentId, frame) => orchestrator.onRuntimeFrame(agentId, frame),
      onClose: (agentId, reason) => orchestrator.onRuntimeClose(agentId, reason),
    },
  });
  // We constructed the orchestrator with a placeholder runtime so
  // hooks can reference it during construction; swap it now.
  (orchestrator as unknown as { opts: { runtime: RuntimeSessionManager } }).opts.runtime = runtime;

  const runner = new ProviderRunner({
    store,
    secrets,
    orchestrator,
    log,
    factories: opts.factories ?? { ...DEFAULT_PROVIDER_FACTORIES },
  });

  const startHealth = opts.startHealth ?? opts.config.healthPort > 0;
  let health: HealthServer | null = null;
  if (startHealth) {
    health = await startHealthServer({
      host: opts.config.healthHost,
      port: opts.config.healthPort,
      log,
      orchestrator,
      runner,
      store,
    });
  }

  const service: IngressService = {
    store,
    secrets,
    hub,
    runtime,
    orchestrator,
    runner,
    health,
    config: opts.config,
    log,
    async shutdown(reason = "shutdown"): Promise<void> {
      await runner.stopAll(reason);
      await runtime.closeAll(reason);
      await health?.close();
    },
  };
  return service;
}

/** Convenience: build + start providers + resume queue. */
export async function startIngress(opts: BuildIngressOptions): Promise<IngressService> {
  const service = await buildIngressService(opts);
  await service.orchestrator.resumePending();
  await service.runner.startAll();
  return service;
}

export { RUNTIME_SOCKET_STATE };
