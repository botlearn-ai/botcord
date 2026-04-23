import type {
  ChannelAdapter,
  ChannelStartContext,
  ChannelStatusSnapshot,
  GatewayConfig,
  GatewayInboundEnvelope,
} from "./types.js";
import type { GatewayLogger } from "./log.js";

/** Exponential backoff tuning for crashed-channel restarts. */
export interface ChannelBackoffOptions {
  initial?: number;
  max?: number;
  factor?: number;
}

/** Constructor options for `ChannelManager`. */
export interface ChannelManagerOptions {
  config: GatewayConfig;
  channels: ChannelAdapter[];
  log: GatewayLogger;
  emit: (env: GatewayInboundEnvelope) => Promise<void>;
  backoffMs?: ChannelBackoffOptions;
}

type LifecycleState = "idle" | "starting" | "running" | "stopping" | "crashed";

interface ChannelEntry {
  adapter: ChannelAdapter;
  accountId: string;
  state: LifecycleState;
  snapshot: ChannelStatusSnapshot;
  controller: AbortController | null;
  runPromise: Promise<void> | null;
  restartTimer: ReturnType<typeof setTimeout> | null;
  nextBackoff: number;
  currentStartAt: number;
  reconnectAttempts: number;
  stopRequested: boolean;
}

const DEFAULT_INITIAL_BACKOFF = 1000;
const DEFAULT_MAX_BACKOFF = 60_000;
const DEFAULT_FACTOR = 2;
const LONG_RUN_THRESHOLD_MS = 30_000;

/** Supervises channel adapters: lifecycle, status tracking, and crash restart with backoff. */
export class ChannelManager {
  private readonly config: GatewayConfig;
  private readonly log: GatewayLogger;
  private readonly emit: (env: GatewayInboundEnvelope) => Promise<void>;
  private readonly initialBackoff: number;
  private readonly maxBackoff: number;
  private readonly factor: number;
  private readonly entries: Map<string, ChannelEntry> = new Map();

  constructor(opts: ChannelManagerOptions) {
    this.config = opts.config;
    this.log = opts.log;
    this.emit = opts.emit;
    this.initialBackoff = opts.backoffMs?.initial ?? DEFAULT_INITIAL_BACKOFF;
    this.maxBackoff = opts.backoffMs?.max ?? DEFAULT_MAX_BACKOFF;
    this.factor = opts.backoffMs?.factor ?? DEFAULT_FACTOR;

    for (const adapter of opts.channels) {
      this.registerAdapter(adapter);
    }
  }

  private registerAdapter(adapter: ChannelAdapter): ChannelEntry {
    const accountId = this.findAccountId(adapter.id);
    const entry: ChannelEntry = {
      adapter,
      accountId,
      state: "idle",
      snapshot: {
        channel: adapter.id,
        accountId,
        running: false,
        reconnectAttempts: 0,
        restartPending: false,
        lastError: null,
      },
      controller: null,
      runPromise: null,
      restartTimer: null,
      nextBackoff: this.initialBackoff,
      currentStartAt: 0,
      reconnectAttempts: 0,
      stopRequested: false,
    };
    this.entries.set(adapter.id, entry);
    return entry;
  }

  /** Start every configured channel; already-running channels are skipped. */
  async startAll(): Promise<void> {
    for (const entry of this.entries.values()) {
      if (entry.state === "idle" || entry.state === "crashed") {
        this.launch(entry);
      }
    }
  }

  /**
   * Launch a single adapter that wasn't present at construction — used by
   * `Gateway.addChannel()` to hot-plug a new agent without a full restart.
   * Idempotent: if an entry with the same id is already running, this is a
   * no-op (after logging a warning).
   */
  addOne(adapter: ChannelAdapter): void {
    const existing = this.entries.get(adapter.id);
    if (existing) {
      this.log.warn("channel.addOne: id already present", { channel: adapter.id });
      return;
    }
    const entry = this.registerAdapter(adapter);
    this.launch(entry);
  }

  /**
   * Stop and forget a single channel. Cancels any pending restart timer,
   * aborts the running turn, awaits the adapter's `stop()`, and removes
   * the entry from the status map. Safe to call on an unknown id.
   */
  async removeOne(id: string, reason?: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.stopRequested = true;
    if (entry.restartTimer) {
      clearTimeout(entry.restartTimer);
      entry.restartTimer = null;
      entry.snapshot = { ...entry.snapshot, restartPending: false };
    }
    const pending: Promise<void>[] = [];
    if (entry.state === "running" || entry.state === "starting") {
      entry.state = "stopping";
      entry.controller?.abort();
      const adapter = entry.adapter;
      if (adapter.stop) {
        try {
          const p = adapter.stop({ reason });
          pending.push(Promise.resolve(p).catch((err) => {
            this.log.warn("channel.stop failed", {
              channel: adapter.id,
              error: err instanceof Error ? err.message : String(err),
            });
          }));
        } catch (err) {
          this.log.warn("channel.stop threw", {
            channel: adapter.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
    if (entry.runPromise) {
      pending.push(entry.runPromise.catch(() => undefined));
    }
    await Promise.all(pending);
    this.entries.delete(id);
  }

  /** Abort every channel, cancel pending restarts, and await all run promises. */
  async stopAll(reason?: string): Promise<void> {
    const pending: Promise<void>[] = [];
    for (const entry of this.entries.values()) {
      entry.stopRequested = true;
      if (entry.restartTimer) {
        clearTimeout(entry.restartTimer);
        entry.restartTimer = null;
        entry.snapshot = { ...entry.snapshot, restartPending: false };
      }
      if (entry.state === "running" || entry.state === "starting") {
        entry.state = "stopping";
        entry.controller?.abort();
        const adapter = entry.adapter;
        if (adapter.stop) {
          try {
            const p = adapter.stop({ reason });
            pending.push(Promise.resolve(p).catch((err) => {
              this.log.warn("channel.stop failed", {
                channel: adapter.id,
                error: err instanceof Error ? err.message : String(err),
              });
            }));
          } catch (err) {
            this.log.warn("channel.stop threw", {
              channel: adapter.id,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }
      if (entry.runPromise) {
        pending.push(entry.runPromise.catch(() => undefined));
      }
    }
    await Promise.all(pending);
    // Reset stop flag so startAll can re-enter.
    for (const entry of this.entries.values()) {
      entry.stopRequested = false;
    }
  }

  /** Return a shallow copy of per-channel status snapshots keyed by channel id. */
  status(): Record<string, ChannelStatusSnapshot> {
    const out: Record<string, ChannelStatusSnapshot> = {};
    for (const [id, entry] of this.entries) {
      out[id] = { ...entry.snapshot };
    }
    return out;
  }

  /** Look up a registered channel adapter by id. */
  getChannel(id: string): ChannelAdapter | undefined {
    return this.entries.get(id)?.adapter;
  }

  private findAccountId(channelId: string): string {
    const cfg = this.config.channels.find((c) => c.id === channelId);
    return cfg?.accountId ?? "";
  }

  private launch(entry: ChannelEntry): void {
    if (entry.state === "starting" || entry.state === "running") return;

    entry.stopRequested = false;
    entry.state = "starting";
    entry.controller = new AbortController();
    entry.currentStartAt = Date.now();
    entry.snapshot = {
      ...entry.snapshot,
      running: true,
      restartPending: false,
      lastStartAt: entry.currentStartAt,
      lastError: null,
      reconnectAttempts: entry.reconnectAttempts,
    };

    const ctx: ChannelStartContext = {
      config: this.config,
      accountId: entry.accountId,
      abortSignal: entry.controller.signal,
      log: this.log,
      emit: (env) => this.safeEmit(entry.adapter.id, env),
      setStatus: (patch) => {
        entry.snapshot = { ...entry.snapshot, ...patch };
      },
    };

    this.log.info("channel starting", { channel: entry.adapter.id });
    const run = (async () => {
      try {
        await entry.adapter.start(ctx);
        this.onExit(entry, null);
      } catch (err) {
        this.onExit(entry, err);
      }
    })();
    entry.runPromise = run;
    entry.state = "running";
  }

  private onExit(entry: ChannelEntry, err: unknown): void {
    const ranForMs = Date.now() - entry.currentStartAt;
    const channelId = entry.adapter.id;
    const crashed = err !== null && err !== undefined;

    entry.snapshot = {
      ...entry.snapshot,
      running: false,
      lastStopAt: Date.now(),
      lastError: crashed
        ? err instanceof Error
          ? err.message
          : String(err)
        : entry.snapshot.lastError ?? null,
    };

    if (crashed) {
      this.log.warn("channel crashed", {
        channel: channelId,
        error: err instanceof Error ? err.message : String(err),
      });
      entry.state = "crashed";
    } else {
      this.log.info("channel exited", { channel: channelId });
      entry.state = "idle";
    }

    if (entry.stopRequested) {
      entry.runPromise = null;
      return;
    }

    // Long-run resets backoff to initial.
    if (ranForMs >= LONG_RUN_THRESHOLD_MS) {
      entry.nextBackoff = this.initialBackoff;
    }

    this.scheduleRestart(entry);
  }

  private scheduleRestart(entry: ChannelEntry): void {
    const delay = entry.nextBackoff;
    entry.snapshot = { ...entry.snapshot, restartPending: true };
    this.log.info("channel restart scheduled", {
      channel: entry.adapter.id,
      delayMs: delay,
      attempts: entry.reconnectAttempts,
    });

    const timer = setTimeout(() => {
      entry.restartTimer = null;
      entry.runPromise = null;
      if (entry.stopRequested) return;
      entry.reconnectAttempts += 1;
      entry.snapshot = {
        ...entry.snapshot,
        restartPending: false,
        reconnectAttempts: entry.reconnectAttempts,
      };
      entry.nextBackoff = Math.min(entry.nextBackoff * this.factor, this.maxBackoff);
      this.launch(entry);
    }, delay);
    entry.restartTimer = timer;
  }

  private async safeEmit(channelId: string, env: GatewayInboundEnvelope): Promise<void> {
    const msg = env?.message;
    if (!msg || typeof msg.id !== "string" || !msg.id || typeof msg.channel !== "string" || !msg.channel) {
      this.log.warn("dropping malformed inbound envelope", {
        channel: channelId,
        hasMessage: Boolean(msg),
        messageId: msg && typeof msg === "object" ? (msg as { id?: unknown }).id : undefined,
      });
      return;
    }
    try {
      await this.emit(env);
    } catch (err) {
      this.log.error("emit failed", {
        channel: channelId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
