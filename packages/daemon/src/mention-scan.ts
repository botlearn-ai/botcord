/**
 * Mention text-fallback (design §4.2). The Hub's `messages.mentioned` flag is
 * sender-supplied and therefore not trustworthy on its own; we OR it with a
 * local scan for `@<display_name>` or `@<agent_id>` so an agent that the
 * sender forgot (or refused) to mark mentioned still wakes when addressed.
 *
 * Kept tiny and synchronous — runs on every inbound message. Both inputs are
 * normalized to lowercase to keep the match case-insensitive.
 */

export interface MentionTargets {
  /** Daemon-known agent id (e.g. `ag_xxx`). Always included when present. */
  agentId?: string;
  /** Display name from the agent's credentials. */
  displayName?: string;
}

/**
 * Return `true` when `text` contains an `@`-prefixed mention of `agentId`
 * or `displayName`. Matches a literal `@` followed by the target — both the
 * `@` and the target are required because plain occurrences of the
 * displayName in conversation should NOT count as a mention.
 */
export function scanMention(text: string | undefined, targets: MentionTargets): boolean {
  if (!text) return false;
  const lower = text.toLowerCase();
  const normalizedAgentId = targets.agentId?.trim().toLowerCase();
  if (normalizedAgentId && lower.includes("(" + normalizedAgentId + ")")) {
    return true;
  }
  const candidates: string[] = [];
  if (normalizedAgentId) candidates.push(normalizedAgentId);
  if (targets.displayName) {
    const trimmed = targets.displayName.trim();
    if (trimmed) candidates.push(trimmed.toLowerCase());
  }
  for (const c of candidates) {
    if (!c) continue;
    if (lower.includes("@" + c)) return true;
  }
  return false;
}
