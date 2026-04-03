/**
 * Memory protocol — prompt injection for persistent working memory.
 *
 * buildWorkingMemoryPrompt(): generates the system context block that
 * instructs the agent to use the working-memory tool and shows current memory.
 */
import type { WorkingMemory } from "./memory.js";

// ── Constants ──────────────────────────────────────────────────────

const MEMORY_SIZE_WARN_CHARS = 2000;

/** Tags that must not appear literally in injected memory content. */
const RESERVED_TAGS_RE = /<\/?current_memory\b[^>]*>/gi;

/**
 * Sanitize memory content before embedding in the prompt.
 * Neutralizes reserved protocol tags to prevent prompt injection via
 * persisted memory content.
 */
function sanitizeMemoryContent(content: string): string {
  return content.replace(RESERVED_TAGS_RE, (tag) =>
    tag.replace(/</g, "‹").replace(/>/g, "›"),
  );
}

// ── Prompt builder ─────────────────────────────────────────────────

/**
 * Build the working memory section to inject into the agent's system prompt.
 */
export function buildWorkingMemoryPrompt(params: {
  workingMemory: WorkingMemory | null;
  warnLarge?: boolean;
}): string {
  const { workingMemory, warnLarge = true } = params;

  const lines: string[] = [
    `[BotCord Working Memory]`,
    `You have a persistent working memory that survives across sessions and rooms.`,
    `Use it to track important facts, pending commitments, and context you want to remember.`,
    ``,
    `To update your working memory, call the botcord_update_working_memory tool.`,
    ``,
    `Rules:`,
    `- Pass the COMPLETE new working memory content to the tool, not a delta.`,
    `- Only update when something meaningful changes. Do not update on every turn.`,
    `- Keep it concise: focus on actionable items, pending commitments, stable preferences, people/room relationships, and key context that will matter later.`,
    `- Good reasons to update: a new long-lived fact, a stable preference, a durable person/profile insight, a pending commitment, or a meaningful change to existing memory.`,
    `- Do NOT update for one-off chatter, transient emotions, verbose summaries of the current turn, or details that are useful only right now.`,
    `- If the information is room-specific operational state, prefer room context / room state tools rather than global working memory.`,
  ];

  if (workingMemory?.content) {
    const content = sanitizeMemoryContent(workingMemory.content);
    lines.push(``);
    lines.push(`Current working memory (last updated: ${workingMemory.updatedAt}):`);
    lines.push(`<current_memory>`);
    lines.push(content);
    lines.push(`</current_memory>`);

    if (warnLarge && content.length > MEMORY_SIZE_WARN_CHARS) {
      lines.push(``);
      lines.push(
        `⚠ Your working memory is ${content.length} characters. ` +
        `Consider condensing it to keep token usage low.`,
      );
    }
  } else {
    lines.push(``);
    lines.push(`Your working memory is currently empty.`);
  }

  return lines.join("\n");
}
