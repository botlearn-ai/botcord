import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// We stub paths by mocking ../config.js. The real config.ts reads homedir()
// at module load; tests must never write into ~/.botcord/.
let tmpDir = "";
let sessionsPath = "";

vi.mock("../config.js", () => {
  return {
    get SESSIONS_PATH() {
      return sessionsPath;
    },
    get DAEMON_DIR_PATH() {
      return tmpDir;
    },
  };
});

// Import AFTER mock registration.
const { SessionStore } = await import("../session-store.js");

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "daemon-store-"));
  sessionsPath = path.join(tmpDir, "sessions.json");
});

afterEach(() => {
  if (tmpDir && existsSync(tmpDir)) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

describe("SessionStore", () => {
  it("returns null for missing entries on a fresh store", () => {
    const store = new SessionStore();
    expect(store.get("ag_a", "rm_1")).toBeNull();
    expect(store.all()).toEqual([]);
  });

  it("upserts with and without topic and keys them separately", () => {
    const store = new SessionStore();
    store.upsert({
      agentId: "ag_a",
      roomId: "rm_1",
      topic: null,
      backend: "claude-code",
      backendSid: "sid-no-topic",
      cwd: "/tmp/a",
      updatedAt: 0,
    });
    store.upsert({
      agentId: "ag_a",
      roomId: "rm_1",
      topic: "tp_x",
      backend: "claude-code",
      backendSid: "sid-topic-x",
      cwd: "/tmp/a",
      updatedAt: 0,
    });
    expect(store.get("ag_a", "rm_1")?.backendSid).toBe("sid-no-topic");
    expect(store.get("ag_a", "rm_1", "tp_x")?.backendSid).toBe("sid-topic-x");
    expect(store.get("ag_a", "rm_1", "tp_y")).toBeNull();
    expect(store.all()).toHaveLength(2);
  });

  it("overwriting an entry bumps updatedAt", async () => {
    const store = new SessionStore();
    store.upsert({
      agentId: "ag_a",
      roomId: "rm_1",
      backend: "claude-code",
      backendSid: "sid-1",
      cwd: "/tmp/a",
      updatedAt: 0,
    });
    const first = store.get("ag_a", "rm_1")!;
    // ensure time advances
    await new Promise((r) => setTimeout(r, 5));
    store.upsert({
      agentId: "ag_a",
      roomId: "rm_1",
      backend: "claude-code",
      backendSid: "sid-2",
      cwd: "/tmp/a",
      updatedAt: 0,
    });
    const second = store.get("ag_a", "rm_1")!;
    expect(second.backendSid).toBe("sid-2");
    expect(second.updatedAt).toBeGreaterThan(first.updatedAt);
  });

  it("flushSync writes atomically via tmp + rename", () => {
    const store = new SessionStore();
    store.upsert({
      agentId: "ag_a",
      roomId: "rm_1",
      backend: "claude-code",
      backendSid: "sid-flush",
      cwd: "/tmp/a",
      updatedAt: 0,
    });
    store.flushSync();
    expect(existsSync(sessionsPath)).toBe(true);
    // tmp file must not linger after rename
    expect(existsSync(sessionsPath + ".tmp")).toBe(false);
    const parsed = JSON.parse(readFileSync(sessionsPath, "utf8"));
    expect(parsed.version).toBe(1);
    expect(parsed.sessions["ag_a:rm_1"].backendSid).toBe("sid-flush");
  });

  it("recovers from corrupt JSON by starting fresh", () => {
    writeFileSync(sessionsPath, "{not valid json", "utf8");
    const store = new SessionStore();
    expect(store.all()).toEqual([]);
    store.upsert({
      agentId: "ag_a",
      roomId: "rm_1",
      backend: "claude-code",
      backendSid: "sid-after-corrupt",
      cwd: "/tmp/a",
      updatedAt: 0,
    });
    store.flushSync();
    const parsed = JSON.parse(readFileSync(sessionsPath, "utf8"));
    expect(parsed.sessions["ag_a:rm_1"].backendSid).toBe("sid-after-corrupt");
  });
});
