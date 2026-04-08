import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  readWorkingMemory,
  writeWorkingMemory,
  readRoomState,
  writeRoomState,
  updateRoomState,
} from "../memory.js";
import type { WorkingMemory, RoomState } from "../memory.js";

// Mock runtime to avoid real workspace resolution
vi.mock("../runtime.js", () => ({
  getBotCordRuntime: vi.fn(() => ({})),
  getConfig: vi.fn(() => null),
}));

describe("memory", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "botcord-memory-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Working Memory ───────────────────────────────────────────────

  describe("WorkingMemory read/write (v2)", () => {
    it("returns null when file does not exist", () => {
      const result = readWorkingMemory(tmpDir);
      expect(result).toBeNull();
    });

    it("writes and reads working memory with sections", () => {
      const wm: WorkingMemory = {
        version: 2,
        goal: "帮客户做PPT",
        sections: {
          contacts: "张三：喜欢蓝色",
          pending_tasks: "- 年终总结PPT",
        },
        updatedAt: "2026-04-01T11:00:00Z",
        sourceSessionKey: "agent:pm:botcord:group:rm_xxx",
      };
      writeWorkingMemory(wm, tmpDir);

      const result = readWorkingMemory(tmpDir);
      expect(result).toEqual(wm);
    });

    it("writes and reads memory without goal", () => {
      const wm: WorkingMemory = {
        version: 2,
        sections: { notes: "some notes" },
        updatedAt: "2026-04-01T11:00:00Z",
      };
      writeWorkingMemory(wm, tmpDir);

      const result = readWorkingMemory(tmpDir);
      expect(result?.goal).toBeUndefined();
      expect(result?.sections.notes).toBe("some notes");
    });

    it("overwrites existing working memory", () => {
      writeWorkingMemory({
        version: 2,
        sections: { notes: "old" },
        updatedAt: "2026-04-01T10:00:00Z",
      }, tmpDir);

      writeWorkingMemory({
        version: 2,
        goal: "new goal",
        sections: { notes: "new" },
        updatedAt: "2026-04-01T11:00:00Z",
      }, tmpDir);

      const result = readWorkingMemory(tmpDir);
      expect(result?.sections.notes).toBe("new");
      expect(result?.goal).toBe("new goal");
    });

    it("creates parent directories if they do not exist", () => {
      const nested = path.join(tmpDir, "deep", "nested");
      writeWorkingMemory({
        version: 2,
        sections: { notes: "test" },
        updatedAt: "2026-04-01T11:00:00Z",
      }, nested);

      const result = readWorkingMemory(nested);
      expect(result?.sections.notes).toBe("test");
    });

    it("atomic write does not leave .tmp files on success", () => {
      writeWorkingMemory({
        version: 2,
        sections: { notes: "test" },
        updatedAt: "2026-04-01T11:00:00Z",
      }, tmpDir);

      const files = readdirSync(tmpDir);
      const tmpFiles = files.filter((f) => f.endsWith(".tmp"));
      expect(tmpFiles).toHaveLength(0);
      expect(existsSync(path.join(tmpDir, "working-memory.json"))).toBe(true);
    });
  });

  // ── v1 Migration ────────────────────────────────────────────────

  describe("v1 → v2 migration", () => {
    it("migrates v1 content into notes section", () => {
      // Write a v1 file directly
      const filePath = path.join(tmpDir, "working-memory.json");
      mkdirSync(tmpDir, { recursive: true });
      writeFileSync(filePath, JSON.stringify({
        version: 1,
        content: "- Alice 在等我 review loss 曲线",
        updatedAt: "2026-04-01T11:00:00Z",
        sourceSessionKey: "agent:pm:botcord:group:rm_xxx",
      }));

      const result = readWorkingMemory(tmpDir);
      expect(result).not.toBeNull();
      expect(result!.version).toBe(2);
      expect(result!.sections.notes).toBe("- Alice 在等我 review loss 曲线");
      expect(result!.goal).toBeUndefined();
    });

    it("migrates empty v1 content to empty sections", () => {
      const filePath = path.join(tmpDir, "working-memory.json");
      mkdirSync(tmpDir, { recursive: true });
      writeFileSync(filePath, JSON.stringify({
        version: 1,
        content: "",
        updatedAt: "2026-04-01T11:00:00Z",
      }));

      const result = readWorkingMemory(tmpDir);
      expect(result).not.toBeNull();
      expect(result!.version).toBe(2);
      expect(Object.keys(result!.sections)).toHaveLength(0);
    });

    it("handles file with no version as v1", () => {
      const filePath = path.join(tmpDir, "working-memory.json");
      mkdirSync(tmpDir, { recursive: true });
      writeFileSync(filePath, JSON.stringify({
        content: "legacy content",
        updatedAt: "2026-04-01T11:00:00Z",
      }));

      const result = readWorkingMemory(tmpDir);
      expect(result).not.toBeNull();
      expect(result!.version).toBe(2);
      expect(result!.sections.notes).toBe("legacy content");
    });
  });

  // ── Room State ───────────────────────────────────────────────────

  describe("RoomState read/write", () => {
    it("returns null when file does not exist", () => {
      const result = readRoomState("rm_nonexistent", tmpDir);
      expect(result).toBeNull();
    });

    it("writes and reads room state", () => {
      const state: RoomState = {
        version: 1,
        checkpointMsgId: "h_123",
        lastSeenAt: "2026-04-01T10:30:00Z",
        mentionBacklog: 1,
        openTopicHints: [
          { topicId: "tp_001", title: "模型训练", status: "open" },
        ],
        note: "",
        updatedAt: "2026-04-01T10:30:00Z",
      };
      writeRoomState("rm_abc", state, tmpDir);

      const result = readRoomState("rm_abc", tmpDir);
      expect(result).toEqual(state);
    });

    it("isolates different room states", () => {
      writeRoomState("rm_a", {
        version: 1,
        checkpointMsgId: "h_1",
        updatedAt: "2026-04-01T10:00:00Z",
      }, tmpDir);
      writeRoomState("rm_b", {
        version: 1,
        checkpointMsgId: "h_2",
        updatedAt: "2026-04-01T10:00:00Z",
      }, tmpDir);

      expect(readRoomState("rm_a", tmpDir)?.checkpointMsgId).toBe("h_1");
      expect(readRoomState("rm_b", tmpDir)?.checkpointMsgId).toBe("h_2");
    });
  });

  // ── updateRoomState ──────────────────────────────────────────────

  describe("updateRoomState", () => {
    it("creates new room state from scratch", () => {
      const result = updateRoomState("rm_new", {
        checkpointMsgId: "h_10",
        lastSeenAt: "2026-04-01T11:00:00Z",
      }, tmpDir);

      expect(result.version).toBe(1);
      expect(result.checkpointMsgId).toBe("h_10");
      expect(result.updatedAt).toBeTruthy();
    });

    it("merges updates into existing state", () => {
      writeRoomState("rm_existing", {
        version: 1,
        checkpointMsgId: "h_5",
        mentionBacklog: 3,
        note: "existing note",
        updatedAt: "2026-04-01T10:00:00Z",
      }, tmpDir);

      const result = updateRoomState("rm_existing", {
        checkpointMsgId: "h_10",
        mentionBacklog: 5,
      }, tmpDir);

      expect(result.checkpointMsgId).toBe("h_10");
      expect(result.mentionBacklog).toBe(5);
      expect(result.note).toBe("existing note"); // preserved
    });

    it("persists merged state to disk", () => {
      updateRoomState("rm_persist", {
        checkpointMsgId: "h_1",
      }, tmpDir);

      const fromDisk = readRoomState("rm_persist", tmpDir);
      expect(fromDisk?.checkpointMsgId).toBe("h_1");
    });
  });
});
