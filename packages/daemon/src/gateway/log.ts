/** Structured logger interface used across the gateway core and adapters. */
export interface GatewayLogger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
  debug(msg: string, meta?: Record<string, unknown>): void;
}

type Level = "info" | "warn" | "error" | "debug";

function write(level: Level, msg: string, meta?: Record<string, unknown>): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    msg,
    ...(meta ?? {}),
  });
  // Always write to stderr so stdout stays clean for NDJSON-style channel output.
  process.stderr.write(line + "\n");
}

/** Default logger that writes JSON lines to stderr; debug lines gated by BOTCORD_GATEWAY_DEBUG. */
export const consoleLogger: GatewayLogger = {
  info: (msg, meta) => write("info", msg, meta),
  warn: (msg, meta) => write("warn", msg, meta),
  error: (msg, meta) => write("error", msg, meta),
  debug: (msg, meta) => {
    if (process.env.BOTCORD_GATEWAY_DEBUG) write("debug", msg, meta);
  },
};
