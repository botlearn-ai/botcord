import { ChannelManager, type ChannelBackoffOptions } from "./channel-manager.js";
import { Dispatcher, type RuntimeFactory } from "./dispatcher.js";
import { consoleLogger, type GatewayLogger } from "./log.js";
import { createRuntime } from "./runtimes/registry.js";
import { SessionStore } from "./session-store.js";
import type {
  ChannelAdapter,
  GatewayChannelConfig,
  GatewayConfig,
  GatewayRuntimeSnapshot,
  InboundObserver,
  SystemContextBuilder,
} from "./types.js";

/** Constructor options for `Gateway`. */
export interface GatewayBootOptions {
  config: GatewayConfig;
  sessionStorePath: string;
  createChannel: (cfg: GatewayChannelConfig) => ChannelAdapter;
  createRuntime?: RuntimeFactory;
  log?: GatewayLogger;
  turnTimeoutMs?: number;
  backoffMs?: ChannelBackoffOptions;
  /**
   * Hook that composes per-turn system context (working memory, cross-room
   * digest, etc.). Forwarded to the dispatcher; errors are logged and do not
   * abort the turn.
   */
  buildSystemContext?: SystemContextBuilder;
  /**
   * Observer called after the dispatcher acks each inbound message. Useful
   * for activity tracking or metrics. Errors are logged and swallowed.
   */
  onInbound?: InboundObserver;
}

/** Default runtime factory: delegates to the built-in registry; ignores extraArgs at construction. */
const defaultRuntimeFactory: RuntimeFactory = (runtimeId) => createRuntime(runtimeId);

/**
 * Top-level gateway bootstrap. Wires `ChannelManager` → `Dispatcher` →
 * `SessionStore` + runtime factory. Channel adapters are constructed from
 * `opts.createChannel` per `config.channels[]` entry and keyed by adapter id.
 */
export class Gateway {
  private readonly config: GatewayConfig;
  private readonly log: GatewayLogger;
  private readonly sessionStore: SessionStore;
  private readonly dispatcher: Dispatcher;
  private readonly channelManager: ChannelManager;
  private readonly channelMap: Map<string, ChannelAdapter>;
  private readonly createChannelFn: (cfg: GatewayChannelConfig) => ChannelAdapter;
  private started = false;
  private stopped = false;

  constructor(opts: GatewayBootOptions) {
    this.config = opts.config;
    this.log = opts.log ?? consoleLogger;
    this.createChannelFn = opts.createChannel;

    this.channelMap = new Map();
    const channelList: ChannelAdapter[] = [];
    for (const cfg of opts.config.channels) {
      const adapter = opts.createChannel(cfg);
      this.channelMap.set(adapter.id, adapter);
      channelList.push(adapter);
    }

    this.sessionStore = new SessionStore({
      path: opts.sessionStorePath,
      log: this.log,
    });

    const runtimeFactory = opts.createRuntime ?? defaultRuntimeFactory;

    this.dispatcher = new Dispatcher({
      config: this.config,
      channels: this.channelMap,
      runtime: runtimeFactory,
      sessionStore: this.sessionStore,
      log: this.log,
      turnTimeoutMs: opts.turnTimeoutMs,
      buildSystemContext: opts.buildSystemContext,
      onInbound: opts.onInbound,
    });

    this.channelManager = new ChannelManager({
      config: this.config,
      channels: channelList,
      log: this.log,
      emit: (env) => this.dispatcher.handle(env),
      backoffMs: opts.backoffMs,
    });
  }

  /** Load persisted sessions and start every configured channel. */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.sessionStore.load();
    await this.channelManager.startAll();
  }

  /** Tear down every channel; idempotent. */
  async stop(reason?: string): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    await this.channelManager.stopAll(reason);
  }

  /** Aggregate status snapshot combining channel and turn state. */
  snapshot(): GatewayRuntimeSnapshot {
    return {
      channels: this.channelManager.status(),
      turns: this.dispatcher.turns(),
    };
  }

  /**
   * Hot-plug a new channel without restarting the gateway. The daemon's
   * control plane calls this after a `provision_agent` frame: it has already
   * written the new agent's credentials to disk and updated `config.json`,
   * and now needs the channel to come online without tearing down peers.
   *
   * The caller supplies a fully-constructed `GatewayChannelConfig` entry;
   * `createChannel` (from the original `GatewayBootOptions`) is invoked to
   * build the adapter. The config entry is appended to `config.channels`
   * so status/router lookups see it; it is otherwise a pure in-memory op.
   */
  async addChannel(cfg: GatewayChannelConfig): Promise<void> {
    if (this.stopped) {
      throw new Error("gateway already stopped");
    }
    if (this.channelMap.has(cfg.id)) {
      throw new Error(`channel "${cfg.id}" already registered`);
    }
    this.config.channels.push(cfg);
    const adapter = this.createChannelFn(cfg);
    this.channelMap.set(adapter.id, adapter);
    this.channelManager.addOne(adapter);
  }

  /**
   * Remove a channel registered earlier (either at boot or via
   * `addChannel`). Aborts the running turn loop, awaits the adapter's
   * `stop()`, drops the entry from the channel map and config.channels.
   * No-op on unknown id.
   */
  async removeChannel(id: string, reason?: string): Promise<void> {
    if (!this.channelMap.has(id)) return;
    await this.channelManager.removeOne(id, reason);
    this.channelMap.delete(id);
    const idx = this.config.channels.findIndex((c) => c.id === id);
    if (idx >= 0) this.config.channels.splice(idx, 1);
  }
}
