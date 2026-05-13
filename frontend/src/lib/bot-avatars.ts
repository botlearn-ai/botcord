/**
 * Bot avatar fallback pool. Files live under `public/agent-avatars/{1..N}.png`.
 *
 * `getBotAvatarUrl(agentId)` returns a deterministic URL for a given agent_id,
 * so the same bot always shows the same face across reloads / components.
 *
 * Humans intentionally do NOT get pool avatars — they keep letter initials —
 * so a quick glance at an avatar tells you "image = bot, letter = human".
 */

import { AGENT_AVATAR_URLS } from "@/lib/agent-avatars";

export function getBotAvatarUrl(agentId: string | null | undefined): string {
  const seed = agentId || "default";
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return AGENT_AVATAR_URLS[hash % AGENT_AVATAR_URLS.length] ?? "/agent-avatars/1.png";
}
