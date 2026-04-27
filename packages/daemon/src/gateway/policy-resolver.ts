/**
 * Daemon-side per-agent attention-policy cache (PR3, design §5).
 *
 * The dispatcher consults this resolver after `onInbound` fires and before
 * the runtime turn enqueues. Cache layout:
 *
 *   - `agent_id`              → global default policy (seeded by
 *                                `provision_agent` + `policy_updated{agent}`).
 *   - `agent_id:room_id`      → genuine per-room override only — installed
 *                                exclusively via `put` from a per-room
 *                                `policy_updated` frame. Inheritance reads
 *                                never write here.
 *
 * `resolve(agent, room)` checks the room key first, then falls back to the
 * global key. This means a per-room override always wins, and the global
 * propagates to every room without explicit fan-out (a global update only
 * needs to refresh the agent_id entry).
 *
 * `invalidate(agent_id, room_id)` drops the matching room entry; the next
 * resolve falls through to the global. `invalidate(agent_id)` drops every
 * entry for that agent — both global and any room overrides — used when
 * the agent is revoked or the cache must rebuild from scratch.
 */

import type { AttentionPolicy } from "@botcord/protocol-core";

/** Public surface — kept narrow so the dispatcher can mock easily in tests. */
export interface PolicyResolverLike {
  resolve(agentId: string, roomId: string | null): Promise<AttentionPolicy>;
  invalidate(agentId: string, roomId?: string): void;
  /**
   * Install (or replace) the cached policy entry for an agent / room. Used
   * by the `policy_updated` control-frame handler to apply embedded policy
   * payloads without forcing a refetch.
   */
  put(agentId: string, roomId: string | null, policy: AttentionPolicy): void;
}

export interface PolicyResolverOptions {
  /** Fetcher for the per-agent default. Returning `undefined` means "no policy known"; the resolver falls back to `mode=always`. */
  fetchGlobal: (agentId: string) => Promise<AttentionPolicy | undefined>;
  /**
   * Optional per-room fetcher. PR2 supplies this; PR3 leaves it
   * unimplemented and the resolver collapses to the global policy.
   */
  fetchEffective?: (
    agentId: string,
    roomId: string,
  ) => Promise<AttentionPolicy | undefined>;
  /** Cache TTL in milliseconds. Defaults to 5 minutes. */
  ttlMs?: number;
}

interface Entry {
  policy: AttentionPolicy;
  expiresAt: number;
}

const DEFAULT_TTL_MS = 5 * 60 * 1000;
const FETCH_FAILED = Symbol("fetch_failed");

/**
 * Force DM rooms (`rm_dm_*`) to `mode: "always"` per design §4.2 — UI never
 * lets the user mute a DM, but a stale cache from before a UX bug is cheap
 * to defend against here.
 */
function maybeForceDm(roomId: string | null, policy: AttentionPolicy): AttentionPolicy {
  if (roomId && roomId.startsWith("rm_dm_") && policy.mode !== "always") {
    return { ...policy, mode: "always" };
  }
  return policy;
}

function defaultPolicy(): AttentionPolicy {
  return { mode: "always", keywords: [] };
}

export class PolicyResolver implements PolicyResolverLike {
  private readonly fetchGlobal: PolicyResolverOptions["fetchGlobal"];
  private readonly fetchEffective?: PolicyResolverOptions["fetchEffective"];
  private readonly ttlMs: number;
  private readonly cache: Map<string, Entry> = new Map();

  constructor(opts: PolicyResolverOptions) {
    this.fetchGlobal = opts.fetchGlobal;
    this.fetchEffective = opts.fetchEffective;
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  }

  async resolve(agentId: string, roomId: string | null): Promise<AttentionPolicy> {
    const now = Date.now();

    // 1. Per-room cache — populated either by a `policy_updated{room_id}`
    //    push (genuine override) or by a prior `fetchEffective` cold-start.
    if (roomId) {
      const roomHit = this.cache.get(cacheKey(agentId, roomId));
      if (roomHit && roomHit.expiresAt > now) return roomHit.policy;
    }

    // 2. If a per-room fetcher is wired, treat it as authoritative for cold
    //    rooms — it returns the override-merged effective policy and so must
    //    not be skipped just because the global cache is warm.
    if (roomId && this.fetchEffective) {
      const fetched = await this.safeFetch(() =>
        this.fetchEffective!(agentId, roomId),
      );
      if (fetched === FETCH_FAILED) return defaultPolicy();
      const policy = fetched ?? defaultPolicy();
      this.cache.set(cacheKey(agentId, roomId), {
        policy: maybeForceDm(roomId, policy),
        expiresAt: now + this.ttlMs,
      });
      return maybeForceDm(roomId, policy);
    }

    // 3. No room override known — inherit from the cached agent-wide global.
    //    Without this layer, group messages collapsed to mode=always whenever
    //    the daemon ran without a per-room fetcher (the current production
    //    state), silently breaking global mention_only/muted.
    const globalKey = cacheKey(agentId, null);
    const globalHit = this.cache.get(globalKey);
    if (globalHit && globalHit.expiresAt > now) {
      return maybeForceDm(roomId, globalHit.policy);
    }

    // 4. Cold start for global.
    const fetched = await this.safeFetch(() => this.fetchGlobal(agentId));
    if (fetched === FETCH_FAILED) return defaultPolicy();
    const policy = fetched ?? defaultPolicy();
    this.cache.set(globalKey, { policy, expiresAt: now + this.ttlMs });
    return maybeForceDm(roomId, policy);
  }

  private async safeFetch(
    fn: () => Promise<AttentionPolicy | undefined>,
  ): Promise<AttentionPolicy | undefined | typeof FETCH_FAILED> {
    try {
      return await fn();
    } catch {
      // Fail-open: a fetch error must not silence the agent. The caller
      // returns the default policy without caching so the next resolve retries.
      return FETCH_FAILED;
    }
  }

  invalidate(agentId: string, roomId?: string): void {
    if (roomId !== undefined) {
      this.cache.delete(cacheKey(agentId, roomId));
      return;
    }
    // Drop every entry for this agent.
    const prefix = agentId + ":";
    for (const key of Array.from(this.cache.keys())) {
      if (key === agentId || key.startsWith(prefix)) {
        this.cache.delete(key);
      }
    }
  }

  put(agentId: string, roomId: string | null, policy: AttentionPolicy): void {
    const key = cacheKey(agentId, roomId);
    this.cache.set(key, {
      policy: maybeForceDm(roomId, policy),
      expiresAt: Date.now() + this.ttlMs,
    });
  }
}

function cacheKey(agentId: string, roomId: string | null): string {
  return roomId ? `${agentId}:${roomId}` : agentId;
}
