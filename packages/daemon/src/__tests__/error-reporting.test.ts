import { describe, expect, it, vi } from "vitest";

import {
  BoundedDedupeErrorReporter,
  buildProcessFatalErrorReport,
  createDaemonErrorReporter,
  initializeErrorReporterSafely,
  installProcessErrorReportingHooks,
  noopErrorReporter,
  reportErrorSafely,
  resolveErrorReporterConfig,
  SentryErrorReporter,
  type DaemonErrorReport,
  type ErrorReporter,
} from "../error-reporting.js";
import type { GatewayLogger } from "../gateway/log.js";

function silentLogger(): GatewayLogger {
  return { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
}

describe("daemon error reporting", () => {
  it("resolves env config and keeps disabled/no-DSN reporting cheap", () => {
    expect(resolveErrorReporterConfig({}).enabled).toBe(true);
    expect(resolveErrorReporterConfig({ BOTCORD_DAEMON_ERROR_REPORTING_ENABLED: "0" }).enabled)
      .toBe(false);
    expect(resolveErrorReporterConfig({
      BOTCORD_DAEMON_ERROR_REPORTING_ENABLED: "1",
      BOTCORD_DAEMON_SENTRY_DSN: " https://sentry.example/1 ",
      BOTCORD_DAEMON_ENVIRONMENT: "production",
      BOTCORD_DAEMON_RELEASE: "v1",
    })).toEqual({
      enabled: true,
      dsn: "https://sentry.example/1",
      environment: "production",
      release: "v1",
    });

    expect(createDaemonErrorReporter({ env: {} })).toBe(noopErrorReporter);
    expect(createDaemonErrorReporter({
      env: {
        BOTCORD_DAEMON_ERROR_REPORTING_ENABLED: "0",
        BOTCORD_DAEMON_SENTRY_DSN: "https://sentry.example/1",
      },
    })).toBe(noopErrorReporter);
    expect(createDaemonErrorReporter({
      env: {
        BOTCORD_DAEMON_ERROR_REPORTING_ENABLED: "1",
        BOTCORD_DAEMON_SENTRY_DSN: "https://sentry.example/1",
      },
      log: silentLogger(),
    })).toBeInstanceOf(BoundedDedupeErrorReporter);
  });

  it("initializes Sentry without adding process exception or rejection handlers", async () => {
    const beforeUnhandled = process.listenerCount("unhandledRejection");
    const beforeUncaught = process.listenerCount("uncaughtException");
    const reporter = new SentryErrorReporter({
      enabled: true,
      dsn: "https://public@example.com/1",
    }, silentLogger());

    try {
      await reporter.init();
      expect(process.listenerCount("unhandledRejection")).toBe(beforeUnhandled);
      expect(process.listenerCount("uncaughtException")).toBe(beforeUncaught);
    } finally {
      const Sentry = await import("@sentry/node");
      await Sentry.close(0);
    }
  });

  it("dedupes repeated events by bounded key", () => {
    const reports: DaemonErrorReport[] = [];
    const inner: ErrorReporter = { report: (event) => reports.push(event) };
    const reporter = new BoundedDedupeErrorReporter(inner, 2);

    reporter.report({ type: "runtime_failure", message: "one", dedupeKey: "err_1:turn_1" });
    reporter.report({ type: "runtime_failure", message: "duplicate", dedupeKey: "err_1:turn_1" });
    reporter.report({ type: "runtime_failure", message: "two", dedupeKey: "err_2:turn_2" });
    reporter.report({ type: "runtime_failure", message: "three", dedupeKey: "err_3:turn_3" });
    reporter.report({ type: "runtime_failure", message: "one-again-after-evict", dedupeKey: "err_1:turn_1" });

    expect(reports.map((event) => event.message)).toEqual([
      "one",
      "two",
      "three",
      "one-again-after-evict",
    ]);
  });

  it("logs and suppresses reporter exceptions", async () => {
    const warn = vi.fn();
    const logger: GatewayLogger = { info: () => {}, warn, error: () => {}, debug: () => {} };
    reportErrorSafely(
      { report: () => { throw new Error("sentry down"); } },
      { type: "runtime_failure", message: "failed" },
      logger,
    );
    expect(warn).toHaveBeenCalledWith("daemon error reporter failed", {
      eventType: "runtime_failure",
      error: "sentry down",
    });

    reportErrorSafely(
      { report: async () => { throw new Error("async down"); } },
      { type: "runtime_failure", message: "failed" },
      logger,
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(warn).toHaveBeenCalledWith("daemon error reporter failed", {
      eventType: "runtime_failure",
      error: "async down",
    });
  });

  it("logs and suppresses reporter init exceptions", async () => {
    const warn = vi.fn();
    const logger: GatewayLogger = { info: () => {}, warn, error: () => {}, debug: () => {} };
    await initializeErrorReporterSafely(
      { init: async () => { throw new Error("init down"); }, report: () => {} },
      logger,
    );

    expect(warn).toHaveBeenCalledWith("daemon error reporter init failed", {
      error: "init down",
    });
  });

  it("installs only an uncaughtExceptionMonitor hook and removes it", () => {
    const beforeMonitor = process.listenerCount("uncaughtExceptionMonitor");
    const beforeUnhandled = process.listenerCount("unhandledRejection");
    const uninstall = installProcessErrorReportingHooks({
      reporter: noopErrorReporter,
      log: silentLogger(),
    });

    try {
      expect(process.listenerCount("uncaughtExceptionMonitor")).toBe(beforeMonitor + 1);
      expect(process.listenerCount("unhandledRejection")).toBe(beforeUnhandled);
    } finally {
      uninstall();
    }

    expect(process.listenerCount("uncaughtExceptionMonitor")).toBe(beforeMonitor);
    expect(process.listenerCount("unhandledRejection")).toBe(beforeUnhandled);
  });

  it("sanitizes process fatal reports", () => {
    const report = buildProcessFatalErrorReport(
      new Error("boom token=abc123 Authorization: Bearer secret"),
      {
        mechanism: "uncaught_exception",
        daemonInstanceId: "di_1",
        hubUrl: "https://hub.test",
      },
    );

    expect(report.type).toBe("process_fatal");
    expect(report.message).toContain("token=[REDACTED]");
    expect(report.message).toContain("Authorization: Bearer [REDACTED]");
    expect(report.tags?.daemon_instance_id).toBe("di_1");
    expect(report.tags?.hub_url).toBe("https://hub.test");
    expect(report.fingerprint).toContain("uncaught_exception");
  });
});
