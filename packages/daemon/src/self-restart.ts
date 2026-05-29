import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";

const DEFAULT_DAEMON_PACKAGE = "@botcord/daemon@latest";
const DEFAULT_SHUTDOWN_DELAY_MS = 750;
const DEFAULT_FORCE_EXIT_MS = 10_000;
const DEFAULT_PARENT_EXIT_WAIT_MS = 30_000;
const DEFAULT_INSTALL_TIMEOUT_MS = 120_000;

export interface DaemonRestartPlan {
  scheduled: boolean;
  updateRequested: boolean;
  updateSupported: boolean;
  installPrefix: string | null;
  packageSpec: string;
}

export interface ScheduleDaemonSelfRestartOptions {
  update?: boolean;
  packageSpec?: string;
  delayMs?: number;
  forceExitAfterMs?: number;
  entrypoint?: string;
  restartArgs?: string[];
}

export interface ScheduleDaemonSelfRestartDeps {
  spawn?: typeof spawn;
  setTimeout?: typeof setTimeout;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  exit?: (code?: number) => never;
  pid?: number;
  execPath?: string;
  argv?: string[];
  env?: NodeJS.ProcessEnv;
}

export function findDaemonInstallPrefix(entrypoint?: string): string | null {
  if (!entrypoint) return null;
  const candidates = [entrypoint, safeRealpath(entrypoint)];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const prefix = installPrefixFromPath(candidate);
    if (prefix) return prefix;
  }
  return null;
}

export function resolveNpmBin(nodePath = process.execPath): string {
  const name = process.platform === "win32" ? "npm.cmd" : "npm";
  const sibling = path.join(path.dirname(nodePath), name);
  return existsSync(sibling) ? sibling : name;
}

export function scheduleDaemonSelfRestart(
  opts: ScheduleDaemonSelfRestartOptions = {},
  deps: ScheduleDaemonSelfRestartDeps = {},
): DaemonRestartPlan {
  const env = deps.env ?? process.env;
  const argv = deps.argv ?? process.argv;
  const entrypoint = opts.entrypoint ?? argv[1];
  if (!entrypoint) {
    throw new Error("cannot restart daemon: process entrypoint is unknown");
  }

  const updateRequested = opts.update !== false;
  const installPrefix = updateRequested ? findDaemonInstallPrefix(entrypoint) : null;
  const packageSpec = opts.packageSpec ?? env.BOTCORD_DAEMON_PACKAGE ?? DEFAULT_DAEMON_PACKAGE;
  const execPath = deps.execPath ?? process.execPath;
  const pid = deps.pid ?? process.pid;
  const restartArgs = opts.restartArgs ?? ["start", "--foreground"];
  const supervisorEnv: NodeJS.ProcessEnv = {
    ...env,
    BOTCORD_DAEMON_CHILD: "1",
    BOTCORD_RESTART_PARENT_PID: String(pid),
    BOTCORD_RESTART_ENTRYPOINT: entrypoint,
    BOTCORD_RESTART_ARGS_JSON: JSON.stringify(restartArgs),
    BOTCORD_RESTART_NODE: execPath,
    BOTCORD_RESTART_NPM_BIN: resolveNpmBin(execPath),
    BOTCORD_RESTART_UPDATE: updateRequested && installPrefix ? "1" : "0",
    BOTCORD_RESTART_INSTALL_PREFIX: installPrefix ?? "",
    BOTCORD_RESTART_PACKAGE: packageSpec,
    BOTCORD_RESTART_PARENT_EXIT_WAIT_MS: String(DEFAULT_PARENT_EXIT_WAIT_MS),
    BOTCORD_RESTART_INSTALL_TIMEOUT_MS: String(DEFAULT_INSTALL_TIMEOUT_MS),
  };

  const spawnImpl = deps.spawn ?? spawn;
  const child = spawnImpl(execPath, ["-e", RESTART_SUPERVISOR_SCRIPT], {
    detached: true,
    stdio: "ignore",
    env: supervisorEnv,
  }) as ChildProcess;
  child.unref();

  const setTimer = deps.setTimeout ?? setTimeout;
  const kill = deps.kill ?? process.kill.bind(process);
  const exit = deps.exit ?? process.exit.bind(process);
  const delayMs = opts.delayMs ?? DEFAULT_SHUTDOWN_DELAY_MS;
  const forceExitAfterMs = opts.forceExitAfterMs ?? DEFAULT_FORCE_EXIT_MS;
  const shutdownTimer = setTimer(() => {
    try {
      kill(pid, "SIGTERM");
    } catch {
      exit(0);
      return;
    }
    const exitTimer = setTimer(() => exit(0), forceExitAfterMs);
    unrefTimer(exitTimer);
  }, delayMs);
  unrefTimer(shutdownTimer);

  return {
    scheduled: true,
    updateRequested,
    updateSupported: installPrefix !== null,
    installPrefix,
    packageSpec,
  };
}

function safeRealpath(input: string): string | null {
  try {
    return realpathSync(input);
  } catch {
    return null;
  }
}

function installPrefixFromPath(input: string): string | null {
  const parts = path.resolve(input).split(path.sep);
  for (let i = parts.length - 3; i >= 0; i--) {
    if (
      parts[i] !== "node_modules" ||
      parts[i + 1] !== "@botcord" ||
      parts[i + 2] !== "daemon"
    ) {
      continue;
    }
    const prefix = parts.slice(0, i).join(path.sep) || path.sep;
    const packageJson = path.join(
      prefix,
      "node_modules",
      "@botcord",
      "daemon",
      "package.json",
    );
    return existsSync(packageJson) ? prefix : null;
  }
  return null;
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  const maybe = timer as { unref?: () => void };
  if (typeof maybe.unref === "function") {
    maybe.unref();
  }
}

const RESTART_SUPERVISOR_SCRIPT = `
const cp = require("node:child_process");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const parentPid = Number(process.env.BOTCORD_RESTART_PARENT_PID || "0");
  const waitMs = Number(process.env.BOTCORD_RESTART_PARENT_EXIT_WAIT_MS || "30000");
  const deadline = Date.now() + waitMs;
  while (parentPid > 0 && alive(parentPid) && Date.now() < deadline) {
    await sleep(250);
  }

  const update = process.env.BOTCORD_RESTART_UPDATE === "1";
  const installPrefix = process.env.BOTCORD_RESTART_INSTALL_PREFIX || "";
  if (update && installPrefix) {
    const npmBin = process.env.BOTCORD_RESTART_NPM_BIN || "npm";
    const packageSpec = process.env.BOTCORD_RESTART_PACKAGE || "${DEFAULT_DAEMON_PACKAGE}";
    const timeout = Number(process.env.BOTCORD_RESTART_INSTALL_TIMEOUT_MS || "120000");
    cp.spawnSync(npmBin, ["install", "--prefix", installPrefix, packageSpec], {
      stdio: "ignore",
      env: process.env,
      timeout,
    });
  }

  const node = process.env.BOTCORD_RESTART_NODE || process.execPath;
  const entrypoint = process.env.BOTCORD_RESTART_ENTRYPOINT;
  if (!entrypoint) process.exit(1);
  let args = ["start", "--foreground"];
  try {
    const parsed = JSON.parse(process.env.BOTCORD_RESTART_ARGS_JSON || "[]");
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) {
      args = parsed;
    }
  } catch {
    // keep default args
  }
  const child = cp.spawn(node, [entrypoint, ...args], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, BOTCORD_DAEMON_CHILD: "1" },
  });
  child.unref();
}

main().catch(() => process.exit(1));
`;
