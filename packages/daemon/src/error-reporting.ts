import type { GatewayLogger } from "./gateway/log.js";
import { errorInfo, sanitizeRuntimeFailureText } from "./gateway/runtime-failure.js";

const DEFAULT_DEDUPE_LIMIT = 1024;

export type ErrorReportType = "runtime_failure" | "process_fatal";

export interface DaemonErrorReport {
  type: ErrorReportType;
  message: string;
  tags?: Record<string, string | number | boolean | null | undefined>;
  context?: Record<string, unknown>;
  fingerprint?: string[];
  dedupeKey?: string;
}

export interface ErrorReporter {
  init?(): Promise<void> | void;
  report(event: DaemonErrorReport): Promise<void> | void;
}

export interface ErrorReporterConfig {
  enabled: boolean;
  dsn?: string;
  environment?: string;
  release?: string;
}

export interface CreateErrorReporterOptions {
  env?: NodeJS.ProcessEnv;
  log?: GatewayLogger;
  dedupeLimit?: number;
}

type SentryModule = typeof import("@sentry/node");

export const noopErrorReporter: ErrorReporter = {
  report: () => {},
};

export function resolveErrorReporterConfig(
  env: NodeJS.ProcessEnv = process.env,
): ErrorReporterConfig {
  return {
    enabled: parseEnabled(env.BOTCORD_DAEMON_ERROR_REPORTING_ENABLED),
    dsn: nonEmpty(env.BOTCORD_DAEMON_SENTRY_DSN),
    environment: nonEmpty(env.BOTCORD_DAEMON_ENVIRONMENT),
    release: nonEmpty(env.BOTCORD_DAEMON_RELEASE),
  };
}

export function createDaemonErrorReporter(
  opts: CreateErrorReporterOptions = {},
): ErrorReporter {
  const config = resolveErrorReporterConfig(opts.env);
  if (!config.enabled || !config.dsn) return noopErrorReporter;
  return new BoundedDedupeErrorReporter(
    new SentryErrorReporter(config, opts.log),
    opts.dedupeLimit,
  );
}

export class BoundedDedupeErrorReporter implements ErrorReporter {
  private readonly seen = new Set<string>();
  private readonly limit: number;

  constructor(
    private readonly inner: ErrorReporter,
    limit = DEFAULT_DEDUPE_LIMIT,
  ) {
    this.limit = Math.max(1, Math.floor(limit));
  }

  init(): Promise<void> | void {
    return this.inner.init?.();
  }

  report(event: DaemonErrorReport): Promise<void> | void {
    const key = event.dedupeKey;
    if (key) {
      if (this.seen.has(key)) return;
      this.seen.add(key);
      if (this.seen.size > this.limit) {
        const oldest = this.seen.values().next().value;
        if (oldest !== undefined) this.seen.delete(oldest);
      }
    }
    return this.inner.report(event);
  }
}

export class SentryErrorReporter implements ErrorReporter {
  private sentry: Promise<SentryModule> | null = null;

  constructor(
    private readonly config: ErrorReporterConfig,
    private readonly log?: GatewayLogger,
  ) {}

  async init(): Promise<void> {
    await this.loadSentry();
  }

  async report(event: DaemonErrorReport): Promise<void> {
    const Sentry = await this.loadSentry();
    Sentry.withScope((scope) => {
      scope.setLevel("error");
      if (event.fingerprint && event.fingerprint.length > 0) {
        scope.setFingerprint(event.fingerprint);
      }
      for (const [key, value] of Object.entries(event.tags ?? {})) {
        if (value === undefined || value === null) continue;
        scope.setTag(key, String(value));
      }
      scope.setTag("event_type", event.type);
      scope.setContext("botcord_daemon", {
        type: event.type,
        ...(event.context ?? {}),
      });
      Sentry.captureMessage(event.message);
    });
  }

  private async loadSentry(): Promise<SentryModule> {
    if (!this.sentry) {
      this.sentry = import("@sentry/node").then((Sentry) => {
        Sentry.init({
          dsn: this.config.dsn,
          environment: this.config.environment,
          release: this.config.release,
        });
        this.log?.info("daemon error reporting initialized", {
          provider: "sentry",
          environment: this.config.environment ?? null,
          release: this.config.release ?? null,
        });
        return Sentry;
      });
    }
    return this.sentry;
  }
}

export function reportErrorSafely(
  reporter: ErrorReporter | undefined,
  event: DaemonErrorReport,
  log?: GatewayLogger,
): void {
  if (!reporter) return;
  try {
    const result = reporter.report(event);
    if (result && typeof (result as Promise<void>).catch === "function") {
      (result as Promise<void>).catch((err) => {
        log?.warn("daemon error reporter failed", {
          eventType: event.type,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
  } catch (err) {
    log?.warn("daemon error reporter failed", {
      eventType: event.type,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function initializeErrorReporterSafely(
  reporter: ErrorReporter | undefined,
  log?: GatewayLogger,
): Promise<void> {
  if (!reporter?.init) return;
  try {
    await reporter.init();
  } catch (err) {
    log?.warn("daemon error reporter init failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export interface ProcessErrorHookOptions {
  reporter: ErrorReporter;
  log?: GatewayLogger;
  daemonInstanceId?: string | null;
  hubUrl?: string | null;
}

export function installProcessErrorReportingHooks(
  opts: ProcessErrorHookOptions,
): () => void {
  const reportFatal = (
    reason: unknown,
    mechanism: "uncaught_exception",
    extra: Record<string, unknown> = {},
  ): void => {
    reportErrorSafely(
      opts.reporter,
      buildProcessFatalErrorReport(reason, {
        mechanism,
        daemonInstanceId: opts.daemonInstanceId,
        hubUrl: opts.hubUrl,
        extra,
      }),
      opts.log,
    );
  };

  const onUncaughtExceptionMonitor = (
    error: Error,
    origin: NodeJS.UncaughtExceptionOrigin,
  ): void => {
    // Do not install an `unhandledRejection` listener here: that changes
    // Node's default rejection semantics. In default throw/strict modes,
    // unhandled rejections surface through this monitor with origin
    // "unhandledRejection".
    reportFatal(error, "uncaught_exception", { origin });
  };

  process.on("uncaughtExceptionMonitor", onUncaughtExceptionMonitor);

  return () => {
    process.off("uncaughtExceptionMonitor", onUncaughtExceptionMonitor);
  };
}

export function buildProcessFatalErrorReport(
  reason: unknown,
  opts: {
    mechanism: "uncaught_exception";
    daemonInstanceId?: string | null;
    hubUrl?: string | null;
    extra?: Record<string, unknown>;
  },
): DaemonErrorReport {
  const info = errorInfo(reason);
  const message = sanitizeRuntimeFailureText(
    info.error_message || "daemon process fatal error",
    2048,
  );
  const stack = reason instanceof Error && reason.stack
    ? sanitizeRuntimeFailureText(reason.stack, 8192)
    : null;
  const tags = {
    mechanism: opts.mechanism,
    daemon_instance_id: opts.daemonInstanceId ?? null,
    hub_url: opts.hubUrl ?? null,
    error_name: info.error_name,
  };
  return {
    type: "process_fatal",
    message,
    tags,
    context: {
      mechanism: opts.mechanism,
      daemon_instance_id: opts.daemonInstanceId ?? null,
      hub_url: opts.hubUrl ?? null,
      error_name: info.error_name,
      error_message: message,
      stack,
      ...(opts.extra ?? {}),
    },
    fingerprint: [
      "botcord-daemon",
      "process_fatal",
      opts.mechanism,
      info.error_name ?? "Error",
      message,
    ],
    dedupeKey: `process_fatal:${opts.mechanism}:${info.error_name ?? "Error"}:${message}`,
  };
}

function parseEnabled(value: string | undefined): boolean {
  if (value === undefined || value.trim() === "") return true;
  if (/^(0|false|no|off|disabled)$/i.test(value.trim())) return false;
  if (/^(1|true|yes|on|enabled)$/i.test(value.trim())) return true;
  return true;
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
