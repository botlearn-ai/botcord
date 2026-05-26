import { execFileSync } from "node:child_process";
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

export interface DaemonProcessInfo {
  pid: number;
  command: string;
}

export function parseDaemonProcesses(
  psOutput: string,
  currentPid: number = process.pid,
): DaemonProcessInfo[] {
  const out: DaemonProcessInfo[] = [];
  for (const line of psOutput.split(/\r?\n/)) {
    const trimmed = line.trim();
    const match = /^(\d+)\s+(.+)$/.exec(trimmed);
    if (!match) continue;
    const pid = Number(match[1]);
    if (!Number.isFinite(pid) || pid <= 0 || pid === currentPid) continue;
    const command = match[2] ?? "";
    if (!isBotCordDaemonStartCommand(command)) continue;
    out.push({ pid, command });
  }
  return out;
}

export function findOtherDaemonProcesses(
  opts: {
    currentPid?: number;
  } = {},
): DaemonProcessInfo[] {
  const currentPid = opts.currentPid ?? process.pid;
  try {
    const output = execFileSync("ps", ["-axo", "pid=,command="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return parseDaemonProcesses(output, currentPid).filter((p) => pidAlive(p.pid));
  } catch {
    return [];
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

export async function stopOtherDaemonProcessesForRestart(
  opts: {
    currentPid?: number;
    logger?: SingletonLogger;
    processes?: DaemonProcessInfo[];
  } = {},
): Promise<DaemonProcessInfo[]> {
  const currentPid = opts.currentPid ?? process.pid;
  const logger = opts.logger ?? noopLogger;
  const processes = opts.processes ?? findOtherDaemonProcesses({ currentPid });
  for (const proc of processes) {
    logger.info("additional daemon process found; restarting", {
      pid: proc.pid,
      command: proc.command,
    });
    try {
      process.kill(proc.pid, "SIGTERM");
    } catch {
      continue;
    }
    if (!(await waitForPidExit(proc.pid, 5_000))) {
      logger.warn("additional daemon did not stop after SIGTERM; sending SIGKILL", {
        pid: proc.pid,
      });
      try {
        process.kill(proc.pid, "SIGKILL");
      } catch {
        // ignore
      }
      await waitForPidExit(proc.pid, 2_000);
    }
  }
  return processes;
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

function isBotCordDaemonStartCommand(command: string): boolean {
  if (!/\bstart\b/.test(command)) return false;
  return (
    command.includes("botcord-daemon") ||
    /(?:^|\s)\S*botcord\S*\/daemon\/dist\/index\.js(?:\s|$)/.test(command) ||
    /(?:^|\s)\S*packages\/daemon\/dist\/index\.js(?:\s|$)/.test(command)
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
