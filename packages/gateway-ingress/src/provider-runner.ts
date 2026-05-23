import type { IngressLogger } from "./log.js";
import type { IngressOrchestrator } from "./orchestrator.js";
import type { ProviderAdapter, ProviderAdapterFactory, ProviderRuntimeContext } from "./providers/types.js";
import type { IngressSecretStore } from "./storage/secrets.js";
import type { IngressStore } from "./storage/store.js";
import type { GatewayConnection, NormalizedInboundMessage } from "./types.js";

/**
 * Spins up one provider adapter per `GatewayConnection`, wiring it to
 * the orchestrator via a `ProviderRuntimeContext`. Adapters never
 * touch storage directly; they call `emit` / `persistCursor` /
 * `markActivity` and the runner persists.
 */
export class ProviderRunner {
  private readonly adapters = new Map<string, { adapter: ProviderAdapter; abort: AbortController }>();
  private readonly providerFactories: Record<string, ProviderAdapterFactory>;

  constructor(
    private readonly opts: {
      store: IngressStore;
      secrets: IngressSecretStore;
      orchestrator: IngressOrchestrator;
      log: IngressLogger;
      factories: Record<string, ProviderAdapterFactory>;
    },
  ) {
    this.providerFactories = opts.factories;
  }

  registerFactory(provider: string, factory: ProviderAdapterFactory): void {
    this.providerFactories[provider] = factory;
  }

  /** Start every enabled connection currently in the store. */
  async startAll(): Promise<void> {
    for (const conn of this.opts.store.listConnections()) {
      if (conn.enabled) await this.startOne(conn);
    }
  }

  async stopAll(reason = "shutdown"): Promise<void> {
    const ids = [...this.adapters.keys()];
    for (const id of ids) {
      await this.stopOne(id, reason);
    }
  }

  /** Add/refresh and start one connection. */
  async startOne(conn: GatewayConnection): Promise<void> {
    const existing = this.adapters.get(conn.id);
    if (existing) await this.stopOne(conn.id, "restart");
    const factory = this.providerFactories[conn.provider];
    if (!factory) {
      this.opts.log.error("no provider factory", { provider: conn.provider });
      return;
    }
    const adapter = factory(conn.id);
    const abort = new AbortController();
    const secret = conn.secretRef
      ? this.opts.secrets.load(conn.secretRef) ?? {}
      : {};
    const ctx: ProviderRuntimeContext = {
      connection: conn,
      secret: secret as Record<string, unknown>,
      log: this.opts.log,
      abortSignal: abort.signal,
      emit: async (message: NormalizedInboundMessage, providerEventId: string) =>
        this.opts.orchestrator.ingest(conn.id, message, providerEventId),
      persistCursor: (cursor) => {
        this.opts.store.updateState(conn.id, { cursor });
      },
      loadCursor: () => this.opts.store.getState(conn.id)?.cursor ?? {},
      markActivity: (patch) => {
        this.opts.store.updateState(conn.id, patch);
      },
    };
    this.opts.orchestrator.registerProvider(adapter);
    this.adapters.set(conn.id, { adapter, abort });
    // Run the adapter in the background; errors are logged but never throw.
    adapter.start(ctx).catch((err) => {
      this.opts.log.error("provider adapter crashed", {
        gatewayId: conn.id,
        err: String(err),
      });
    });
  }

  async stopOne(gatewayId: string, reason = "stop"): Promise<void> {
    const entry = this.adapters.get(gatewayId);
    if (!entry) return;
    entry.abort.abort();
    await entry.adapter.stop(reason).catch((err) => {
      this.opts.log.warn("provider stop failed", { gatewayId, err: String(err) });
    });
    this.opts.orchestrator.unregisterProvider(gatewayId);
    this.adapters.delete(gatewayId);
  }

  isRunning(gatewayId: string): boolean {
    return this.adapters.has(gatewayId);
  }
}
