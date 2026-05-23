/**
 * Tiny structured logger interface, mirroring `packages/daemon/src/gateway/log.ts`.
 * Production code can swap the console logger for one that adds a JSON
 * formatter / external sink; tests pass a noop logger.
 */
export interface IngressLogger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

function format(message: string, meta?: Record<string, unknown>): string {
  if (!meta || Object.keys(meta).length === 0) return message;
  try {
    return `${message} ${JSON.stringify(meta)}`;
  } catch {
    return message;
  }
}

export const consoleLogger: IngressLogger = {
  debug(m, meta) {
    if (process.env.BOTCORD_INGRESS_DEBUG === "1") {
      console.debug(`[ingress] ${format(m, meta)}`);
    }
  },
  info(m, meta) {
    console.info(`[ingress] ${format(m, meta)}`);
  },
  warn(m, meta) {
    console.warn(`[ingress] ${format(m, meta)}`);
  },
  error(m, meta) {
    console.error(`[ingress] ${format(m, meta)}`);
  },
};

export const noopLogger: IngressLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};
