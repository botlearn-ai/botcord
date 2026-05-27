import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
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

const DEFAULT_LOCK_WAIT_MS = 15_000;
const DEFAULT_LOCK_RETRY_MS = 50;

export interface DaemonSingletonLock {
  lockPath: string;
  release(): void;
}

export function defaultLockPath(pidPath = PID_PATH): string {
  return `${pidPath}.lock`;
}

export function readPid(pidPath = PID_PATH): number | null {
  if (!existsSync(pidPath)) return null;
  const raw = readFileSync(pidPath, "utf8").trim();
  const pid = Number(raw);
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}

function readLockOwner(lockPath: string): number | null {
  return readPid(path.join(lockPath, "owner.pid"));
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

export async function acquireDaemonSingletonLock(
  opts: {
    lockPath?: string;
    pidPath?: string;
    currentPid?: number;
    logger?: SingletonLogger;
    timeoutMs?: number;
  } = {},
): Promise<DaemonSingletonLock> {
  const pidPath = opts.pidPath ?? PID_PATH;
  const lockPath = opts.lockPath ?? defaultLockPath(pidPath);
  const currentPid = opts.currentPid ?? process.pid;
  const logger = opts.logger ?? noopLogger;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_LOCK_WAIT_MS;
  const deadline = Date.now() + timeoutMs;

  ensureParentDir(lockPath);
  while (true) {
    try {
      mkdirSync(lockPath, { mode: 0o700 });
      writeFileSync(path.join(lockPath, "owner.pid"), String(currentPid), { mode: 0o600 });
      return {
        lockPath,
        release() {
          const owner = readLockOwner(lockPath);
          if (owner !== null && owner !== currentPid) return;
          try {
            rmSync(lockPath, { recursive: true, force: true });
          } catch {
            // ignore
          }
        },
      };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw err;
    }

    const owner = readLockOwner(lockPath);
    if (owner === currentPid) {
      return {
        lockPath,
        release() {
          try {
            rmSync(lockPath, { recursive: true, force: true });
          } catch {
            // ignore
          }
        },
      };
    }
    if (owner !== null && pidAlive(owner)) {
      logger.info("daemon singleton lock owner found; restarting", { pid: owner });
      await stopExistingDaemonForRestart(owner, { pidPath, currentPid, logger });
    }

    const refreshedOwner = readLockOwner(lockPath);
    if (refreshedOwner === null || !pidAlive(refreshedOwner)) {
      try {
        rmSync(lockPath, { recursive: true, force: true });
      } catch {
        // another starter may have removed/recreated it
      }
    }

    if (Date.now() >= deadline) {
      throw new Error(`timed out acquiring daemon singleton lock at ${lockPath}`);
    }
    await delay(DEFAULT_LOCK_RETRY_MS);
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
  const pidPath = opts.pidPath ?? PID_PATH;
  // Cloud-mode startup writes the PID file before `saveConfig` runs, so
  // the daemon dir may not exist yet. mkdir its parent (0700) so the
  // first write doesn't crash with ENOENT.
  ensureParentDir(pidPath);
  writeFileSync(pidPath, String(opts.currentPid ?? process.pid), { mode: 0o600 });
}

export function removePidFile(pidPath = PID_PATH): void {
  try {
    unlinkSync(pidPath);
  } catch {
    // ignore
  }
}

export function isBotCordDaemonStartCommand(command: string): boolean {
  if (!/\bstart\b/.test(command)) return false;
  // Only treat a row as "the daemon" when argv[0] is the real entry point:
  // either the node interpreter (running `dist/index.js`) or the resolved
  // `botcord-daemon` bin shim. Reject shell wrappers (`sh`, `bash`, `npm`,
  // `npx`, `timeout`, ...) — their argv mentions `botcord-daemon` only as a
  // literal arg, not as the executable being run. Killing a wrapper takes
  // out the actual daemon it started, which is exactly the bug we want
  // to avoid in cloud sandboxes.
  const exe = (command.trim().split(/\s+/, 1)[0] ?? "").split("/").pop() ?? "";
  const isNode = /^node(\d.*)?$/.test(exe);
  const isDaemonBin = exe === "botcord-daemon";
  if (!isNode && !isDaemonBin) return false;
  return (
    // node-resolved bin shim, e.g. .../node_modules/.bin/botcord-daemon
    /\/\.?bin\/botcord-daemon(?:\s|$)/.test(command) ||
    // direct bin invocation, e.g. /usr/local/bin/botcord-daemon or argv[0]=botcord-daemon
    /(?:^|\s)\S*botcord-daemon(?:\s|$)/.test(command) ||
    // node running the published daemon entry script
    /\bbotcord\S*\/daemon\/dist\/index\.js(?:\s|$)/.test(command) ||
    // node running the in-repo daemon entry script (dev / monorepo)
    /\bpackages\/daemon\/dist\/index\.js(?:\s|$)/.test(command)
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ensureParentDir(filePath: string): void {
  try {
    mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  } catch {
    // best-effort — the next filesystem operation will surface real errors
  }
}
