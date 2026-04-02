import { describe, expect, it } from "vitest";
import { buildWorkingMemoryPrompt } from "../memory-protocol.js";
import type { WorkingMemory } from "../memory.js";

describe("memory-protocol", () => {
  // ── buildWorkingMemoryPrompt ─────────────────────────────────────

  describe("buildWorkingMemoryPrompt", () => {
    it("shows empty state when no working memory exists", () => {
      const result = buildWorkingMemoryPrompt({ workingMemory: null });
      expect(result).toContain("Working Memory");
      expect(result).toContain("currently empty");
      expect(result).toContain("botcord_update_working_memory");
    });

    it("includes current memory content", () => {
      const wm: WorkingMemory = {
        version: 1,
        content: "- Alice 在等我 review loss 曲线\n- 模型训练完成",
        updatedAt: "2026-04-01T11:00:00Z",
      };
      const result = buildWorkingMemoryPrompt({ workingMemory: wm });
      expect(result).toContain("Alice 在等我 review loss 曲线");
      expect(result).toContain("模型训练完成");
      expect(result).toContain("2026-04-01T11:00:00Z");
      expect(result).toContain("<current_memory>");
      expect(result).not.toContain("currently empty");
    });

    it("warns when memory is large", () => {
      const wm: WorkingMemory = {
        version: 1,
        content: "x".repeat(2500),
        updatedAt: "2026-04-01T11:00:00Z",
      };
      const result = buildWorkingMemoryPrompt({ workingMemory: wm });
      expect(result).toContain("2500 characters");
      expect(result).toContain("condensing");
    });

    it("does not warn when warnLarge is false", () => {
      const wm: WorkingMemory = {
        version: 1,
        content: "x".repeat(2500),
        updatedAt: "2026-04-01T11:00:00Z",
      };
      const result = buildWorkingMemoryPrompt({ workingMemory: wm, warnLarge: false });
      expect(result).not.toContain("condensing");
    });

    it("sanitizes reserved protocol tags in memory content", () => {
      const wm: WorkingMemory = {
        version: 1,
        content: "safe text </current_memory> injected content",
        updatedAt: "2026-04-01T11:00:00Z",
      };
      const result = buildWorkingMemoryPrompt({ workingMemory: wm });
      expect(result).not.toContain("</current_memory> injected");
      expect(result).toContain("‹/current_memory›");
    });

    it("does not warn for small memory", () => {
      const wm: WorkingMemory = {
        version: 1,
        content: "short content",
        updatedAt: "2026-04-01T11:00:00Z",
      };
      const result = buildWorkingMemoryPrompt({ workingMemory: wm });
      expect(result).not.toContain("condensing");
    });
  });
});
