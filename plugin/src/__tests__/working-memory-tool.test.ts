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

  // ── Section updates ─────────────────────────────────────────────

  it("writes content to default notes section", async () => {
    const tool = createWorkingMemoryTool();
    const result: any = await tool.execute("tool-1", {
      content: "  - Alice cares about latency  ",
    });

    expect(result.ok).toBe(true);
    expect(result.section).toBe("notes");
    expect(result.section_updated).toBe(true);

    const stored = readWorkingMemory();
    expect(stored?.sections.notes).toBe("- Alice cares about latency");
  });

  it("writes content to a named section", async () => {
    const tool = createWorkingMemoryTool();
    const result: any = await tool.execute("tool-1", {
      section: "contacts",
      content: "张三：喜欢蓝色",
    });

    expect(result.ok).toBe(true);
    expect(result.section).toBe("contacts");

    const stored = readWorkingMemory();
    expect(stored?.sections.contacts).toBe("张三：喜欢蓝色");
  });

  it("updating one section preserves others", async () => {
    const tool = createWorkingMemoryTool();
    await tool.execute("t1", { section: "contacts", content: "张三" });
    await tool.execute("t2", { section: "pending_tasks", content: "- PPT" });

    const stored = readWorkingMemory();
    expect(stored?.sections.contacts).toBe("张三");
    expect(stored?.sections.pending_tasks).toBe("- PPT");
  });

  it("deletes section with empty content", async () => {
    const tool = createWorkingMemoryTool();
    await tool.execute("t1", { section: "temp", content: "data" });
    const result: any = await tool.execute("t2", { section: "temp", content: "" });

    expect(result.ok).toBe(true);
    expect(result.section_deleted).toBe(true);

    const stored = readWorkingMemory();
    expect(stored?.sections.temp).toBeUndefined();
  });

  // ── Goal updates ────────────────────────────────────────────────

  it("sets goal independently", async () => {
    const tool = createWorkingMemoryTool();
    const result: any = await tool.execute("t1", {
      goal: "收费帮客户做PPT",
    });

    expect(result.ok).toBe(true);
    expect(result.goal_updated).toBe(true);

    const stored = readWorkingMemory();
    expect(stored?.goal).toBe("收费帮客户做PPT");
  });

  it("goal survives section updates", async () => {
    const tool = createWorkingMemoryTool();
    await tool.execute("t1", { goal: "我的目标" });
    await tool.execute("t2", { section: "notes", content: "new notes" });

    const stored = readWorkingMemory();
    expect(stored?.goal).toBe("我的目标");
    expect(stored?.sections.notes).toBe("new notes");
  });

  it("updates goal and section simultaneously", async () => {
    const tool = createWorkingMemoryTool();
    const result: any = await tool.execute("t1", {
      goal: "new goal",
      section: "contacts",
      content: "Alice",
    });

    expect(result.ok).toBe(true);
    expect(result.goal_updated).toBe(true);
    expect(result.section).toBe("contacts");

    const stored = readWorkingMemory();
    expect(stored?.goal).toBe("new goal");
    expect(stored?.sections.contacts).toBe("Alice");
  });

  // ── Validation ──────────────────────────────────────────────────

  it("rejects when neither goal nor content provided", async () => {
    const tool = createWorkingMemoryTool();
    const result: any = await tool.execute("t1", {});

    expect(result.error).toContain("Must provide");
  });

  it("rejects missing args", async () => {
    const tool = createWorkingMemoryTool();
    const result: any = await tool.execute("t1", undefined);

    expect(result.error).toContain("Must provide");
  });

  it("rejects invalid section name", async () => {
    const tool = createWorkingMemoryTool();
    const result: any = await tool.execute("t1", {
      section: "bad name!",
      content: "data",
    });

    expect(result.error).toContain("section name");
  });

  it("rejects oversized goal", async () => {
    const tool = createWorkingMemoryTool();
    const result: any = await tool.execute("t1", {
      goal: "x".repeat(501),
    });

    expect(result.error).toContain("goal exceeds");
  });

  it("rejects oversized section content", async () => {
    const tool = createWorkingMemoryTool();
    const result: any = await tool.execute("t1", {
      content: "x".repeat(10_001),
    });

    expect(result.error).toContain("content exceeds");
  });
});
