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
const RESERVED_TAGS_RE = /<\/?(?:current_memory|section_\w+)\b[^>]*>/gi;

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
    `Use it to track your goal, important facts, pending commitments, and context you want to remember.`,
    ``,
    `Memory is organized into named sections. Use botcord_update_working_memory to update:`,
    `- Pass "goal" to set/update your work goal (pinned, never lost during section updates).`,
    `- Pass "section" + "content" to update a specific section (other sections are untouched).`,
    `- Pass "section" + empty "content" to delete a section.`,
    `- Without "section", updates the default "notes" section.`,
    ``,
    `Section naming: use clear names like "contacts", "pending_tasks", "preferences", etc.`,
    `Only update when something meaningful changes. Do not update on every turn.`,
    `Keep each section concise and focused on its topic.`,
  ];

  if (!workingMemory) {
    lines.push(``, `Your working memory is currently empty.`);
    return lines.join("\n");
  }

  const sectionEntries = Object.entries(workingMemory.sections || {});
  const hasGoal = !!workingMemory.goal;
  const hasSections = sectionEntries.length > 0;

  if (!hasGoal && !hasSections) {
    lines.push(``, `Your working memory is currently empty.`);
    return lines.join("\n");
  }

  lines.push(``, `Current working memory (last updated: ${workingMemory.updatedAt}):`);

  let totalChars = 0;

  if (hasGoal) {
    // Collapse newlines to prevent prompt injection via goal field
    const goal = sanitizeMemoryContent(workingMemory.goal!.replace(/[\r\n]+/g, " ").trim());
    lines.push(``, `Goal: ${goal}`);
    totalChars += goal.length;
  }

  for (const [name, content] of sectionEntries) {
    if (!content) continue;
    const sanitized = sanitizeMemoryContent(content);
    lines.push(``, `<section_${name}>`, sanitized, `</section_${name}>`);
    totalChars += sanitized.length;
  }

  if (warnLarge && totalChars > MEMORY_SIZE_WARN_CHARS) {
    lines.push(
      ``,
      `⚠ Your working memory is ${totalChars} characters. ` +
      `Consider condensing sections to keep token usage low.`,
    );
  }

  return lines.join("\n");
}
