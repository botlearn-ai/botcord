import type { UserAgent } from "./types";

export function sortOwnedAgentsNewestFirst<T extends Pick<UserAgent, "agent_id" | "claimed_at">>(
  agents: readonly T[],
): T[] {
  return [...agents].sort((a, b) => {
    const aClaimedAt = Date.parse(a.claimed_at);
    const bClaimedAt = Date.parse(b.claimed_at);
    const aTime = Number.isNaN(aClaimedAt) ? 0 : aClaimedAt;
    const bTime = Number.isNaN(bClaimedAt) ? 0 : bClaimedAt;
    if (aTime !== bTime) return bTime - aTime;
    return a.agent_id.localeCompare(b.agent_id);
  });
}
