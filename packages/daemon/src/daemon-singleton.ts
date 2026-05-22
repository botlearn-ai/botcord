import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { PID_PATH } from "./config.js";

export interface SingletonLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}

const noopLogger: SingletonLogger = {
  info() {
    // noop
  },
  warn() {
    // noop
  },
};

export function readPid(pidPath = PID_PATH): number | null {
  if (!existsSync(pidPath)) return null;
  const raw = readFileSync(pidPath, "utf8").trim();
  const pid = Number(raw);
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function waitForPidExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return true;
    await delay(100);
  }
  return !pidAlive(pid);
}

export async function stopExistingDaemonForRestart(
  pid: number,
  opts: {
    pidPath?: string;
    currentPid?: number;
    logger?: SingletonLogger;
  } = {},
): Promise<void> {
  const pidPath = opts.pidPath ?? PID_PATH;
  const currentPid = opts.currentPid ?? process.pid;
  const logger = opts.logger ?? noopLogger;
  if (pid === currentPid) return;
  logger.info("existing daemon found; restarting", { pid });
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    removePidFile(pidPath);
    return;
  }
  if (!(await waitForPidExit(pid, 5_000))) {
    logger.warn("existing daemon did not stop after SIGTERM; sending SIGKILL", { pid });
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // ignore
    }
    await waitForPidExit(pid, 2_000);
  }
  removePidFile(pidPath);
}

export async function stopDaemonFromPidFileForRestart(
  opts: {
    pidPath?: string;
    currentPid?: number;
    logger?: SingletonLogger;
  } = {},
): Promise<void> {
  const pidPath = opts.pidPath ?? PID_PATH;
  const existing = readPid(pidPath);
  if (existing && pidAlive(existing)) {
    await stopExistingDaemonForRestart(existing, opts);
  }
}

export function ensureNoOtherDaemonFromPidFile(
  opts: {
    pidPath?: string;
    currentPid?: number;
  } = {},
): number | null {
  const pidPath = opts.pidPath ?? PID_PATH;
  const currentPid = opts.currentPid ?? process.pid;
  const existing = readPid(pidPath);
  if (existing && existing !== currentPid && pidAlive(existing)) {
    return existing;
  }
  return null;
}

export function writeCurrentPid(
  opts: {
    pidPath?: string;
    currentPid?: number;
  } = {},
): void {
  writeFileSync(opts.pidPath ?? PID_PATH, String(opts.currentPid ?? process.pid), { mode: 0o600 });
}

export function removePidFile(pidPath = PID_PATH): void {
  try {
    unlinkSync(pidPath);
  } catch {
    // ignore
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
