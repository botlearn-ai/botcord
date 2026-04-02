/**
 * Memory hook — glue between OpenClaw hooks and the memory subsystem.
 *
 * - buildWorkingMemoryHookResult(): before_prompt_build handler
 */
import { readWorkingMemory } from "./memory.js";
import { buildWorkingMemoryPrompt } from "./memory-protocol.js";
import { getSessionRoom } from "./room-context.js";

// ── before_prompt_build handler ────────────────────────────────────

/**
 * Build the working memory hook result for injection into the agent prompt.
 * Returns prependContext so it appears close to the user message.
 */
export async function buildWorkingMemoryHookResult(
  sessionKey: string | undefined,
): Promise<{ prependContext?: string } | null> {
  if (!sessionKey) return null;

  // Inject for registered BotCord sessions and the owner-chat session.
  // Owner-chat uses a fixed key and is never registered via inbound dispatch,
  // but still needs working memory for cross-session continuity.
  const isOwnerChat = sessionKey === "botcord:owner:main";
  if (!isOwnerChat && !getSessionRoom(sessionKey)) return null;

  try {
    const wm = readWorkingMemory();
    const prompt = buildWorkingMemoryPrompt({ workingMemory: wm });
    return { prependContext: prompt };
  } catch (err: any) {
    console.warn("[botcord] memory-hook: failed to read working memory:", err?.message ?? err);
    return null;
  }
}
