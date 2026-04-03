/**
 * botcord_update_working_memory — explicit tool for persisting working memory.
 */
import { writeWorkingMemory } from "../memory.js";

const MAX_WORKING_MEMORY_CHARS = 20_000;

export function createWorkingMemoryTool() {
  return {
    name: "botcord_update_working_memory",
    label: "Update Working Memory",
    description:
      "Replace BotCord's persistent working memory with the complete new content. " +
      "Use only when important long-lived context changes, such as a stable fact, preference, person profile, relationship, or pending commitment that should influence future replies. " +
      "Do not call on every turn, and do not use it for one-off chatter or room-local temporary state.",
    parameters: {
      type: "object" as const,
      properties: {
        content: {
          type: "string" as const,
          description:
            "The complete replacement content for working memory. " +
            "Keep it concise and include only important facts, stable preferences, durable person/relationship context, pending commitments, and other key context that should persist across sessions and rooms.",
        },
      },
      required: ["content"],
    },
    execute: async (_toolCallId: any, args: any) => {
      if (typeof args?.content !== "string") {
        return { error: "content must be a string" };
      }

      const content = args.content.trim();
      if (!content) {
        return { error: "content must not be empty — use a separate mechanism to clear memory" };
      }
      if (content.length > MAX_WORKING_MEMORY_CHARS) {
        return { error: `content exceeds ${MAX_WORKING_MEMORY_CHARS} characters` };
      }

      try {
        writeWorkingMemory({
          version: 1,
          content,
          updatedAt: new Date().toISOString(),
        });
        return {
          ok: true,
          updated: true,
          content_length: content.length,
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return { error: `Failed to update working memory: ${message}` };
      }
    },
  };
}
