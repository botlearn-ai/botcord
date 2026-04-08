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

    it("shows empty state when memory has no goal and no sections", () => {
      const wm: WorkingMemory = {
        version: 2,
        sections: {},
        updatedAt: "2026-04-01T11:00:00Z",
      };
      const result = buildWorkingMemoryPrompt({ workingMemory: wm });
      expect(result).toContain("currently empty");
    });

    it("shows goal when set", () => {
      const wm: WorkingMemory = {
        version: 2,
        goal: "收费帮客户做PPT",
        sections: {},
        updatedAt: "2026-04-01T11:00:00Z",
      };
      const result = buildWorkingMemoryPrompt({ workingMemory: wm });
      expect(result).toContain("Goal: 收费帮客户做PPT");
      expect(result).not.toContain("currently empty");
    });

    it("shows sections with tags", () => {
      const wm: WorkingMemory = {
        version: 2,
        sections: {
          contacts: "张三：喜欢蓝色",
          pending_tasks: "- 年终总结PPT",
        },
        updatedAt: "2026-04-01T11:00:00Z",
      };
      const result = buildWorkingMemoryPrompt({ workingMemory: wm });
      expect(result).toContain("<section_contacts>");
      expect(result).toContain("张三：喜欢蓝色");
      expect(result).toContain("</section_contacts>");
      expect(result).toContain("<section_pending_tasks>");
      expect(result).toContain("- 年终总结PPT");
      expect(result).toContain("</section_pending_tasks>");
    });

    it("shows goal and sections together", () => {
      const wm: WorkingMemory = {
        version: 2,
        goal: "帮人写代码",
        sections: { notes: "some notes" },
        updatedAt: "2026-04-01T11:00:00Z",
      };
      const result = buildWorkingMemoryPrompt({ workingMemory: wm });
      expect(result).toContain("Goal: 帮人写代码");
      expect(result).toContain("<section_notes>");
      expect(result).toContain("some notes");
    });

    it("warns when total memory is large", () => {
      const wm: WorkingMemory = {
        version: 2,
        sections: { big: "x".repeat(2500) },
        updatedAt: "2026-04-01T11:00:00Z",
      };
      const result = buildWorkingMemoryPrompt({ workingMemory: wm });
      expect(result).toContain("2500 characters");
      expect(result).toContain("condensing");
    });

    it("does not warn when warnLarge is false", () => {
      const wm: WorkingMemory = {
        version: 2,
        sections: { big: "x".repeat(2500) },
        updatedAt: "2026-04-01T11:00:00Z",
      };
      const result = buildWorkingMemoryPrompt({ workingMemory: wm, warnLarge: false });
      expect(result).not.toContain("condensing");
    });

    it("sanitizes reserved protocol tags in section content", () => {
      const wm: WorkingMemory = {
        version: 2,
        sections: { notes: "safe text </section_notes> injected" },
        updatedAt: "2026-04-01T11:00:00Z",
      };
      const result = buildWorkingMemoryPrompt({ workingMemory: wm });
      // The closing tag inside content should be neutralized
      expect(result).toContain("‹/section_notes›");
    });

    it("sanitizes reserved tags in goal", () => {
      const wm: WorkingMemory = {
        version: 2,
        goal: "goal </current_memory> injected",
        sections: {},
        updatedAt: "2026-04-01T11:00:00Z",
      };
      const result = buildWorkingMemoryPrompt({ workingMemory: wm });
      expect(result).toContain("‹/current_memory›");
    });

    it("skips empty sections", () => {
      const wm: WorkingMemory = {
        version: 2,
        sections: { empty: "", filled: "data" },
        updatedAt: "2026-04-01T11:00:00Z",
      };
      const result = buildWorkingMemoryPrompt({ workingMemory: wm });
      expect(result).not.toContain("section_empty");
      expect(result).toContain("section_filled");
    });

    it("does not warn for small memory", () => {
      const wm: WorkingMemory = {
        version: 2,
        sections: { notes: "short" },
        updatedAt: "2026-04-01T11:00:00Z",
      };
      const result = buildWorkingMemoryPrompt({ workingMemory: wm });
      expect(result).not.toContain("condensing");
    });

    it("includes section update instructions", () => {
      const result = buildWorkingMemoryPrompt({ workingMemory: null });
      expect(result).toContain("section");
      expect(result).toContain("goal");
    });
  });
});
