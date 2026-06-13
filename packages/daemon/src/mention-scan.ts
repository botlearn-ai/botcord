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

interface MentionMessage {
  accountId?: string;
  text?: string;
  mentioned?: boolean;
  raw?: unknown;
}

interface MentionBatchEntry {
  text?: unknown;
  mentioned?: unknown;
  envelope?: { payload?: { text?: unknown } };
}

function rawText(entry: unknown): string {
  if (!entry || typeof entry !== "object") return "";
  const rec = entry as MentionBatchEntry;
  if (typeof rec.text === "string") return rec.text;
  if (typeof rec.envelope?.payload?.text === "string")
    return rec.envelope.payload.text;
  return "";
}

/**
 * Return `true` when `text` contains an `@`-prefixed mention of `agentId`
 * or `displayName`. Matches a literal `@` followed by the target — both the
 * `@` and the target are required because plain occurrences of the
 * displayName in conversation should NOT count as a mention.
 */
export function scanMention(
  text: string | undefined,
  targets: MentionTargets
): boolean {
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

/**
 * Effective mention signal used after the Hub has normalized a turn. Mirrors
 * the attention gate's local fallback for `@<agent_id>` so runtime wake,
 * prompt context, and room status reactions agree even when Hub
 * `mentioned=false`.
 */
export function effectiveMention(message: MentionMessage): boolean {
  if (message.mentioned === true) return true;
  const targets = { agentId: message.accountId };
  if (scanMention(message.text, targets)) return true;
  const raw = message.raw;
  const batch =
    raw &&
    typeof raw === "object" &&
    Array.isArray((raw as { batch?: unknown }).batch)
      ? (raw as { batch: unknown[] }).batch
      : null;
  if (!batch) return false;
  return batch.some((entry) => scanMention(rawText(entry), targets));
}

/**
 * Apply the local mention fallback to the normalized inbound message. The
 * daemon attention gates have access to credential display names; mutating the
 * message there keeps later dispatcher status, system context, and turn text
 * composition aligned with the wake decision.
 */
export function applyLocalMention(
  message: MentionMessage,
  targets: MentionTargets
): boolean {
  let localMention = scanMention(message.text, targets);
  const raw = message.raw;
  const batch =
    raw &&
    typeof raw === "object" &&
    Array.isArray((raw as { batch?: unknown }).batch)
      ? (raw as { batch: unknown[] }).batch
      : null;
  if (batch) {
    for (const entry of batch) {
      if (!scanMention(rawText(entry), targets)) continue;
      localMention = true;
      if (entry && typeof entry === "object") {
        (entry as MentionBatchEntry).mentioned = true;
      }
    }
  }
  if (localMention) message.mentioned = true;
  return localMention;
}
