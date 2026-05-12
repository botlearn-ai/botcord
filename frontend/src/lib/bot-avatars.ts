/**
 * Bot avatar pool. Files live under `public/avatars/bots/{1..N}.png`.
 *
 * `getBotAvatarUrl(agentId)` returns a deterministic URL for a given agent_id,
 * so the same bot always shows the same face across reloads / components.
 *
 * Humans intentionally do NOT get pool avatars — they keep letter initials —
 * so a quick glance at an avatar tells you "image = bot, letter = human".
 */

export const BOT_AVATAR_COUNT = 43;

export function getBotAvatarUrl(agentId: string | null | undefined): string {
  const seed = agentId || "default";
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  const n = (hash % BOT_AVATAR_COUNT) + 1;
  return `/avatars/bots/${n}.png`;
}
