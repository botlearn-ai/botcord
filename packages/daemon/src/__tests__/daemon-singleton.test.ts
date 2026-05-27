import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ensureNoOtherDaemonFromPidFile,
  isBotCordDaemonStartCommand,
  parseDaemonProcesses,
  readPid,
  removePidFile,
  stopOtherDaemonProcessesForRestart,
  stopDaemonFromPidFileForRestart,
  writeCurrentPid,
} from "../daemon-singleton.js";

describe("daemon singleton pid helpers", () => {
  let tmpDir: string;
  let children: ChildProcess[];

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "botcord-singleton-test-"));
    children = [];
  });

  afterEach(() => {
    for (const child of children) {
      if (child.pid) {
        try {
          process.kill(child.pid, "SIGKILL");
        } catch {
          // ignore
        }
      }
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes and reads the current pid", () => {
    const pidPath = path.join(tmpDir, "daemon.pid");

    writeCurrentPid({ pidPath, currentPid: 12345 });

    expect(readPid(pidPath)).toBe(12345);
    expect(readFileSync(pidPath, "utf8")).toBe("12345");
  });

  it("creates the parent directory if missing (cloud-mode first boot)", () => {
    // Cloud-mode start writes the PID file before `saveConfig` runs, so
    // ~/.botcord/daemon/ may not exist yet. Without the mkdir the daemon
    // crashes immediately with ENOENT.
    const pidPath = path.join(tmpDir, "fresh-cloud-home", "daemon", "daemon.pid");

    writeCurrentPid({ pidPath, currentPid: 7890 });

    expect(readPid(pidPath)).toBe(7890);
  });

  it("does not report the current process as another daemon", () => {
    const pidPath = path.join(tmpDir, "daemon.pid");
    writeCurrentPid({ pidPath, currentPid: process.pid });

    expect(ensureNoOtherDaemonFromPidFile({ pidPath, currentPid: process.pid })).toBeNull();
  });

  it("terminates the daemon recorded in the pid file before restart", async () => {
    const pidPath = path.join(tmpDir, "daemon.pid");
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    children.push(child);
    await waitForPid(child);
    writeCurrentPid({ pidPath, currentPid: child.pid! });

    await stopDaemonFromPidFileForRestart({ pidPath, currentPid: process.pid });

    expect(existsSync(pidPath)).toBe(false);
    await waitForExit(child);
    expect(child.exitCode === null && child.signalCode === null).toBe(false);
  });

  it("removes stale pid files", () => {
    const pidPath = path.join(tmpDir, "daemon.pid");
    writeCurrentPid({ pidPath, currentPid: 99999999 });

    removePidFile(pidPath);

    expect(readPid(pidPath)).toBeNull();
  });

  it("finds botcord daemon start commands in ps output", () => {
    const out = parseDaemonProcesses(
      [
        "  111 node /Users/me/.botcord/daemon/node_modules/.bin/botcord-daemon start --foreground",
        "  222 node /opt/botcord/daemon/dist/index.js start --foreground",
        "  333 node /tmp/other.js",
        `  ${process.pid} node /Users/me/.botcord/daemon/node_modules/.bin/botcord-daemon start --foreground`,
      ].join("\n"),
      process.pid,
    );

    expect(out.map((p) => p.pid)).toEqual([111, 222]);
  });

  it("does not match shell wrappers whose argv mentions botcord-daemon as a literal", () => {
    // These are the wrapper command lines we observed in cloud sandboxes;
    // they must NOT be classified as the daemon, otherwise the singleton
    // check kills the wrapper and takes the actual daemon down with it.
    const wrappers = [
      "npm exec --yes --package @botcord/daemon@latest -- botcord-daemon start --foreground",
      "npx --yes --package @botcord/daemon@latest -- botcord-daemon start --foreground",
      "sh -c botcord-daemon start --foreground",
      "/bin/bash -l -c export npm_config_cache=/tmp/c; npm exec --yes --package @botcord/daemon@latest -- botcord-daemon start --foreground",
      "timeout 30 npm exec --yes --package @botcord/daemon@latest -- botcord-daemon start --foreground",
    ];
    for (const cmd of wrappers) {
      expect(isBotCordDaemonStartCommand(cmd), `wrongly matched wrapper: ${cmd}`).toBe(false);
    }
  });

  it("matches the actual daemon entry processes", () => {
    const matches = [
      // node running the published daemon (npx / npm exec resolution under _npx)
      "node /tmp/botcord-npm-cache/_npx/abc123/node_modules/@botcord/daemon/dist/index.js start --foreground",
      // node running the resolved bin shim
      "node /Users/me/.botcord/daemon/node_modules/.bin/botcord-daemon start --foreground",
      // direct invocation of the bin
      "/usr/local/bin/botcord-daemon start --foreground",
      // monorepo dev: node running packages/daemon/dist/index.js
      "node /home/dev/botcord/packages/daemon/dist/index.js start --foreground",
    ];
    for (const cmd of matches) {
      expect(isBotCordDaemonStartCommand(cmd), `failed to match daemon: ${cmd}`).toBe(true);
    }
  });

  it("terminates extra daemon processes discovered outside the pid file", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    children.push(child);
    await waitForPid(child);

    await stopOtherDaemonProcessesForRestart({
      currentPid: process.pid,
      processes: [{ pid: child.pid!, command: "node /opt/botcord/daemon/dist/index.js start --foreground" }],
    });

    await waitForExit(child);
    expect(child.exitCode === null && child.signalCode === null).toBe(false);
  });
});

async function waitForPid(child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!child.pid && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (!child.pid) throw new Error("child pid was not assigned");
}

async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
}
