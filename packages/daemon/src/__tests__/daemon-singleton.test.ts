import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ensureNoOtherDaemonFromPidFile,
  readPid,
  removePidFile,
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
