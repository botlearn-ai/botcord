/**
 * Daemon-side per-agent attention-policy cache (PR3, design §5).
 *
 * The dispatcher consults this resolver after `onInbound` fires and before
 * the runtime turn enqueues. Cache keys:
 *
 *   - `agent_id`              → global default policy
 *   - `agent_id:room_id`      → effective per-room override (PR2 will start
 *                                writing to this slot once override APIs land)
 *
 * On cache miss the resolver calls the caller-supplied `fetchEffective`
 * factory; on `invalidate(agent_id, room_id)` the matching entry is dropped,
 * and on `invalidate(agent_id)` every entry for that agent is dropped.
 *
 * For PR3 the daemon does not yet know the per-room override URL — that is
 * PR2's surface. When `fetchEffective` is omitted we fall back to the
 * global policy, which means the resolver is effectively per-agent only
 * until PR2 wires up the per-room fetch.
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
    const key = cacheKey(agentId, roomId);
    const now = Date.now();
    const hit = this.cache.get(key);
    if (hit && hit.expiresAt > now) {
      return hit.policy;
    }

    let fetched: AttentionPolicy | undefined;
    try {
      if (roomId && this.fetchEffective) {
        fetched = await this.fetchEffective(agentId, roomId);
      } else {
        fetched = await this.fetchGlobal(agentId);
      }
    } catch {
      // Fail-open: a fetch error must not silence the agent. Use the default
      // policy and skip caching so the next resolve retries.
      return defaultPolicy();
    }

    const policy = maybeForceDm(roomId, fetched ?? defaultPolicy());
    this.cache.set(key, { policy, expiresAt: now + this.ttlMs });
    return policy;
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
