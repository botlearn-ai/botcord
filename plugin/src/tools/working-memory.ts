/**
 * botcord_update_working_memory — explicit tool for persisting working memory.
 *
 * Supports named sections for granular updates:
 * - { goal: "..." }                         → update goal only
 * - { section: "contacts", content: "..." } → update one section
 * - { content: "..." }                      → update default "notes" section
 * - { section: "old", content: "" }          → delete a section
 */
import { readWorkingMemory, writeWorkingMemory } from "../memory.js";

const MAX_SECTION_CHARS = 10_000;
const MAX_GOAL_CHARS = 500;
const MAX_TOTAL_CHARS = 20_000;
const DEFAULT_SECTION = "notes";

export function createWorkingMemoryTool() {
  return {
    name: "botcord_update_working_memory",
    label: "Update Working Memory",
    description:
      "Update BotCord's persistent working memory. Memory is organized into named sections " +
      "that are updated independently — changing one section never affects others. " +
      "Pass 'goal' to set your work goal (pinned, survives all updates). " +
      "Pass 'section' + 'content' to update a specific section. " +
      "Pass only 'content' to update the default 'notes' section. " +
      "Pass 'section' with empty 'content' to delete a section. " +
      "Use clear section names like 'contacts', 'pending_tasks', 'preferences' (letters, digits, underscores only).",
    parameters: {
      type: "object" as const,
      properties: {
        goal: {
          type: "string" as const,
          description:
            "Set or update the agent's work goal. This is pinned and never lost when sections are updated. " +
            `Max ${MAX_GOAL_CHARS} characters.`,
        },
        section: {
          type: "string" as const,
          description:
            "Name of the section to update (e.g. 'contacts', 'pending_tasks', 'preferences'). " +
            `Defaults to '${DEFAULT_SECTION}' if not specified.`,
        },
        content: {
          type: "string" as const,
          description:
            "The complete replacement content for the specified section. " +
            "Pass empty string to delete the section. " +
            `Max ${MAX_SECTION_CHARS} characters per section.`,
        },
      },
      required: [],
    },
    execute: async (_toolCallId: any, args: any) => {
      // Type validation — reject wrong types explicitly
      if (args?.goal !== undefined && typeof args.goal !== "string") {
        return { error: "'goal' must be a string" };
      }
      if (args?.section !== undefined && typeof args.section !== "string") {
        return { error: "'section' must be a string" };
      }
      if (args?.content !== undefined && typeof args.content !== "string") {
        return { error: "'content' must be a string" };
      }

      const goalArg = typeof args?.goal === "string" ? args.goal.trim() : undefined;
      const sectionArg = typeof args?.section === "string" ? args.section.trim() : undefined;
      const contentArg = typeof args?.content === "string" ? args.content : undefined;

      // Must provide at least one of goal or content
      if (goalArg === undefined && contentArg === undefined) {
        return { error: "Must provide at least 'goal' or 'content'" };
      }

      // Validate goal
      if (goalArg !== undefined && goalArg.length > MAX_GOAL_CHARS) {
        return { error: `goal exceeds ${MAX_GOAL_CHARS} characters` };
      }

      // Validate section name
      const sectionName = sectionArg || DEFAULT_SECTION;
      if (!/^[a-zA-Z0-9_]+$/.test(sectionName)) {
        return { error: "section name must contain only letters, digits, and underscores" };
      }

      // Validate content
      const content = contentArg?.trim() ?? undefined;
      if (content !== undefined && content.length > MAX_SECTION_CHARS) {
        return { error: `content exceeds ${MAX_SECTION_CHARS} characters for section '${sectionName}'` };
      }

      try {
        // Read existing memory (or start fresh)
        const existing = readWorkingMemory() ?? {
          version: 2 as const,
          sections: {},
          updatedAt: "",
        };

        // Update goal if provided
        if (goalArg !== undefined) {
          existing.goal = goalArg || undefined;
        }

        // Update section if content provided
        if (content !== undefined) {
          if (content === "") {
            delete existing.sections[sectionName];
          } else {
            existing.sections[sectionName] = content;
          }
        }

        // Check total size
        const totalChars =
          (existing.goal?.length ?? 0) +
          Object.values(existing.sections).reduce((sum, s) => sum + s.length, 0);
        if (totalChars > MAX_TOTAL_CHARS) {
          return { error: `total working memory exceeds ${MAX_TOTAL_CHARS} characters (current: ${totalChars})` };
        }

        existing.updatedAt = new Date().toISOString();

        writeWorkingMemory(existing);

        const result: Record<string, unknown> = {
          ok: true,
        };
        if (goalArg !== undefined) {
          result.goal_updated = true;
        }
        if (content !== undefined) {
          result.section = sectionName;
          result.section_updated = content !== "";
          result.section_deleted = content === "";
        }
        result.total_sections = Object.keys(existing.sections).length;
        result.total_chars = totalChars;

        return result;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return { error: `Failed to update working memory: ${message}` };
      }
    },
  };
}
