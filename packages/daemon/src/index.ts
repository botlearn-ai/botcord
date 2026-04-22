#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
  loadConfig,
  saveConfig,
  initDefaultConfig,
  PID_PATH,
  CONFIG_FILE_PATH,
  type DaemonConfig,
  type RouteRule,
} from "./config.js";
import { runDaemon } from "./daemon.js";
import { log, LOG_FILE_PATH } from "./log.js";

const HELP = `botcord-daemon — BotCord local daemon

Usage: botcord-daemon <command> [options]

Commands:
  init --agent <ag_xxx> [--cwd <path>]   Create ~/.botcord/daemon/config.json
  start [--foreground]                    Start the daemon (forks to background by default)
  stop                                    Stop the running daemon (SIGTERM)
  status                                  Print daemon status (pid, agent)
  logs [-f]                               Print log tail (use -f to follow)
  route add --room <rm_xxx>|--prefix <rm_oc_> --adapter <claude-code|codex|gemini> --cwd <path>
  route list
  route remove --room <rm_xxx>|--prefix <rm_xxx>
  config                                  Print resolved config

Env:
  BOTCORD_CLAUDE_BIN    Override 'claude' CLI path
  BOTCORD_DAEMON_DEBUG  Enable debug logging
`;

interface ParsedArgs {
  cmd: string;
  sub?: string;
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const [cmd, maybeSub, ...rest] = argv;
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  let sub: string | undefined;
  if (maybeSub && !maybeSub.startsWith("-")) {
    sub = maybeSub;
  } else if (maybeSub) {
    positional.unshift(maybeSub);
  }
  const args = [...positional, ...rest];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith("--") && !a.startsWith("-")) continue;
    const key = a.replace(/^-+/, "");
    const next = args[i + 1];
    if (next && !next.startsWith("-")) {
      flags[key] = next;
      i++;
    } else {
      flags[key] = true;
    }
  }
  return { cmd: cmd ?? "", sub, flags };
}

function readPid(): number | null {
  if (!existsSync(PID_PATH)) return null;
  const raw = readFileSync(PID_PATH, "utf8").trim();
  const pid = Number(raw);
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function cmdInit(args: ParsedArgs): Promise<void> {
  const agentId = typeof args.flags.agent === "string" ? args.flags.agent : "";
  if (!agentId) {
    console.error("--agent <ag_xxx> is required");
    process.exit(1);
  }
  const cwd =
    typeof args.flags.cwd === "string" ? path.resolve(args.flags.cwd) : homedir();
  const cfg = initDefaultConfig(agentId, cwd);
  saveConfig(cfg);
  console.log(`wrote ${CONFIG_FILE_PATH}`);
}

async function cmdStart(args: ParsedArgs): Promise<void> {
  const cfg = loadConfig();
  const foreground = args.flags.foreground === true;

  const existing = readPid();
  if (existing && pidAlive(existing)) {
    console.error(`daemon already running (pid ${existing})`);
    process.exit(1);
  }

  if (!foreground) {
    // Detached child re-exec in foreground mode.
    const child = spawn(process.execPath, [process.argv[1], "start", "--foreground"], {
      detached: true,
      stdio: "ignore",
      env: process.env,
    });
    child.unref();
    // Wait briefly then write PID file (child will overwrite with its own).
    writeFileSync(PID_PATH, String(child.pid), { mode: 0o600 });
    console.log(`daemon started (pid ${child.pid})`);
    return;
  }

  // Foreground: we ARE the daemon.
  writeFileSync(PID_PATH, String(process.pid), { mode: 0o600 });
  const handle = await runDaemon(cfg);

  const shutdown = async (sig: string) => {
    log.info("signal received", { sig });
    await handle.stop();
    try {
      unlinkSync(PID_PATH);
    } catch {
      // ignore
    }
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  await handle.wait();
}

async function cmdStop(): Promise<void> {
  const pid = readPid();
  if (!pid) {
    console.error("no pid file found");
    process.exit(1);
  }
  if (!pidAlive(pid)) {
    console.error(`pid ${pid} not alive; removing stale pid file`);
    try {
      unlinkSync(PID_PATH);
    } catch {
      // ignore
    }
    process.exit(1);
  }
  process.kill(pid, "SIGTERM");
  console.log(`sent SIGTERM to ${pid}`);
}

async function cmdStatus(): Promise<void> {
  const pid = readPid();
  if (!pid) {
    console.log("stopped");
    return;
  }
  const alive = pidAlive(pid);
  let agent = "?";
  try {
    agent = loadConfig().agentId;
  } catch {
    // ignore
  }
  console.log(JSON.stringify({ pid, alive, agentId: agent, config: CONFIG_FILE_PATH }, null, 2));
}

async function cmdLogs(args: ParsedArgs): Promise<void> {
  const follow = args.flags.f === true || args.flags.follow === true;
  if (!existsSync(LOG_FILE_PATH)) {
    console.error(`no log file at ${LOG_FILE_PATH}`);
    process.exit(1);
  }
  if (follow) {
    // `tail -f` is simpler and more robust than watching fs events ourselves.
    const child = spawn("tail", ["-n", "100", "-f", LOG_FILE_PATH], { stdio: "inherit" });
    process.on("SIGINT", () => child.kill("SIGINT"));
    await new Promise((resolve) => child.on("close", resolve));
    return;
  }
  const data = readFileSync(LOG_FILE_PATH, "utf8");
  const lines = data.split("\n");
  console.log(lines.slice(-100).join("\n"));
}

async function cmdRoute(args: ParsedArgs): Promise<void> {
  const cfg = loadConfig();
  const sub = args.sub;
  if (sub === "list") {
    console.log(JSON.stringify({ default: cfg.defaultRoute, routes: cfg.routes }, null, 2));
    return;
  }
  if (sub === "add") {
    const roomId = typeof args.flags.room === "string" ? args.flags.room : undefined;
    const prefix = typeof args.flags.prefix === "string" ? args.flags.prefix : undefined;
    const adapter = (typeof args.flags.adapter === "string" ? args.flags.adapter : "claude-code") as RouteRule["adapter"];
    const cwd = typeof args.flags.cwd === "string" ? path.resolve(args.flags.cwd) : "";
    if (!roomId && !prefix) {
      console.error("--room or --prefix required");
      process.exit(1);
    }
    if (!cwd) {
      console.error("--cwd required");
      process.exit(1);
    }
    cfg.routes.push({
      match: roomId ? { roomId } : { roomPrefix: prefix },
      adapter,
      cwd,
    });
    saveConfig(cfg);
    console.log("route added");
    return;
  }
  if (sub === "remove") {
    const roomId = typeof args.flags.room === "string" ? args.flags.room : undefined;
    const prefix = typeof args.flags.prefix === "string" ? args.flags.prefix : undefined;
    const before = cfg.routes.length;
    cfg.routes = cfg.routes.filter((r) => {
      if (roomId && r.match.roomId === roomId) return false;
      if (prefix && r.match.roomPrefix === prefix) return false;
      return true;
    });
    saveConfig(cfg);
    console.log(`removed ${before - cfg.routes.length} route(s)`);
    return;
  }
  console.error(HELP);
  process.exit(1);
}

async function cmdConfig(): Promise<void> {
  const cfg: DaemonConfig = loadConfig();
  console.log(JSON.stringify(cfg, null, 2));
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.cmd || args.flags.help === true || args.flags.h === true) {
    console.log(HELP);
    process.exit(args.cmd ? 0 : 1);
  }
  try {
    switch (args.cmd) {
      case "init":
        await cmdInit(args);
        break;
      case "start":
        await cmdStart(args);
        break;
      case "stop":
        await cmdStop();
        break;
      case "status":
        await cmdStatus();
        break;
      case "logs":
        await cmdLogs(args);
        break;
      case "route":
        await cmdRoute(args);
        break;
      case "config":
        await cmdConfig();
        break;
      default:
        console.error(`unknown command: ${args.cmd}`);
        console.error(HELP);
        process.exit(1);
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

main();
