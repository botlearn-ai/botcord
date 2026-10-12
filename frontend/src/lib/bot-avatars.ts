/**
 * Default avatar for a bot without an explicit `avatar_url`.
 *
 * `getBotAvatarUrl(agentId)` is deterministic: the character and the hue are
 * picked from two independent hashes of the agent_id, so 16 characters × 8 hues
 * give 128 combinations and bots in the same room rarely look alike.
 *
 * Humans intentionally do NOT get pool avatars — they keep letter initials —
 * so a quick glance at an avatar tells you "image = bot, letter = human".
 */

import { AGENT_AVATAR_CHARACTERS, AGENT_AVATAR_HUES, agentAvatarUrl } from "./agent-avatars";

function hashSeed(seed: string, multiplier: number): number {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * multiplier + seed.charCodeAt(i)) >>> 0;
  }
  return hash;
}

export function getBotAvatarUrl(agentId: string | null | undefined): string {
  const seed = agentId || "default";
  const character = AGENT_AVATAR_CHARACTERS[hashSeed(seed, 31) % AGENT_AVATAR_CHARACTERS.length];
  const hue = AGENT_AVATAR_HUES[hashSeed(seed, 131) % AGENT_AVATAR_HUES.length];
  return agentAvatarUrl(character, hue);
}
