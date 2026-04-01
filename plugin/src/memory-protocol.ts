/**
 * Memory protocol — prompt injection and <memory_update> extraction.
 *
 * - buildWorkingMemoryPrompt(): generates the system context block that
 *   instructs the agent to use <memory_update> and shows current memory.
 * - extractMemoryUpdate(): parses agent output, strips <memory_update>
 *   blocks, and returns the cleaned text + extracted memory content.
 */
import type { WorkingMemory } from "./memory.js";

// ── Constants ──────────────────────────────────────────────────────

const MEMORY_SIZE_WARN_CHARS = 2000;

/** Tags that must not appear literally in injected memory content. */
const RESERVED_TAGS_RE =
  /<\/?(current_memory|memory_update)\b[^>]*>/gi;

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
    `Use it to track important facts, pending tasks, and context you want to remember.`,
    ``,
    `To update your working memory, include a <memory_update> block in your response:`,
    `<memory_update>`,
    `- Complete replacement content for your working memory`,
    `- Include everything you want to remember (this replaces, not appends)`,
    `</memory_update>`,
    ``,
    `Rules:`,
    `- The <memory_update> block will be stripped from your visible reply — it is never sent to other agents.`,
    `- Content inside <memory_update> must be the COMPLETE new working memory, not a delta.`,
    `- Only update when something meaningful changes. Do not update on every turn.`,
    `- Keep it concise: focus on actionable items, pending commitments, and key context.`,
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

// ── Memory update extraction ───────────────────────────────────────

const MEMORY_UPDATE_RE =
  /<memory_update>([\s\S]*?)<\/memory_update>/g;

/**
 * Extract <memory_update> blocks from agent output text.
 *
 * Returns:
 * - cleanedText: the text with all <memory_update> blocks removed
 * - memoryContent: the last <memory_update> content (complete replacement),
 *   or null if no block was found
 */
export function extractMemoryUpdate(text: string): {
  cleanedText: string;
  memoryContent: string | null;
} {
  let memoryContent: string | null = null;
  let match: RegExpExecArray | null;

  // Reset regex state
  MEMORY_UPDATE_RE.lastIndex = 0;

  while ((match = MEMORY_UPDATE_RE.exec(text)) !== null) {
    // Use the last match (complete replacement semantics)
    memoryContent = match[1].trim();
  }

  // Remove all <memory_update> blocks from the text
  const cleanedText = text
    .replace(MEMORY_UPDATE_RE, "")
    .replace(/\n{3,}/g, "\n\n") // collapse excessive blank lines left by removal
    .trim();

  return { cleanedText, memoryContent };
}
