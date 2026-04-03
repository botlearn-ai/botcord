import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createWorkingMemoryTool } from "../tools/working-memory.js";
import { readWorkingMemory } from "../memory.js";

vi.mock("../runtime.js", () => ({
  getBotCordRuntime: vi.fn(() => ({})),
  getConfig: vi.fn(() => null),
}));

describe("working-memory tool", () => {
  let tmpDir: string;
  const originalHome = process.env.HOME;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "botcord-working-memory-tool-"));
    process.env.HOME = tmpDir;
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes complete replacement working memory", async () => {
    const tool = createWorkingMemoryTool();
    const result: any = await tool.execute("tool-1", {
      content: "  - Alice cares about latency\n- Bob owns training  ",
    });

    expect(result.ok).toBe(true);
    expect(result.updated).toBe(true);
    expect(result.content_length).toBe("- Alice cares about latency\n- Bob owns training".length);

    const stored = readWorkingMemory();
    expect(stored?.content).toBe("- Alice cares about latency\n- Bob owns training");
  });

  it("rejects non-string content", async () => {
    const tool = createWorkingMemoryTool();
    const result: any = await tool.execute("tool-2", {
      content: 123,
    });

    expect(result.error).toBe("content must be a string");
  });

  it("rejects missing args", async () => {
    const tool = createWorkingMemoryTool();
    const result: any = await tool.execute("tool-3", undefined);

    expect(result.error).toBe("content must be a string");
  });
});
