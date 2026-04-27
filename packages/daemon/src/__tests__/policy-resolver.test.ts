import { describe, expect, it, vi } from "vitest";
import { PolicyResolver } from "../gateway/policy-resolver.js";
import type { AttentionPolicy } from "@botcord/protocol-core";

describe("PolicyResolver", () => {
  it("returns default policy when fetchGlobal returns undefined", async () => {
    const resolver = new PolicyResolver({ fetchGlobal: async () => undefined });
    const p = await resolver.resolve("ag_a", null);
    expect(p.mode).toBe("always");
    expect(p.keywords).toEqual([]);
  });

  it("caches the global fetch result and reuses on the next resolve", async () => {
    const fetchGlobal = vi.fn(async () => ({ mode: "muted", keywords: [] }) as AttentionPolicy);
    const resolver = new PolicyResolver({ fetchGlobal });
    await resolver.resolve("ag_a", null);
    await resolver.resolve("ag_a", null);
    expect(fetchGlobal).toHaveBeenCalledTimes(1);
  });

  it("invalidate(agent) drops all entries for that agent", async () => {
    const fetchGlobal = vi.fn(async () => ({ mode: "always", keywords: [] }) as AttentionPolicy);
    const resolver = new PolicyResolver({ fetchGlobal });
    await resolver.resolve("ag_a", null);
    await resolver.resolve("ag_a", null);
    expect(fetchGlobal).toHaveBeenCalledTimes(1);
    resolver.invalidate("ag_a");
    await resolver.resolve("ag_a", null);
    expect(fetchGlobal).toHaveBeenCalledTimes(2);
  });

  it("invalidate(agent, room) only drops the matching room entry", async () => {
    const policy: AttentionPolicy = { mode: "always", keywords: [] };
    const fetchGlobal = vi.fn(async () => policy);
    const fetchEffective = vi.fn(async () => policy);
    const resolver = new PolicyResolver({ fetchGlobal, fetchEffective });

    await resolver.resolve("ag_a", null);
    await resolver.resolve("ag_a", "rm_1");
    await resolver.resolve("ag_a", "rm_2");
    expect(fetchGlobal).toHaveBeenCalledTimes(1);
    expect(fetchEffective).toHaveBeenCalledTimes(2);

    resolver.invalidate("ag_a", "rm_1");
    await resolver.resolve("ag_a", null); // still cached
    await resolver.resolve("ag_a", "rm_2"); // still cached
    await resolver.resolve("ag_a", "rm_1"); // refetched
    expect(fetchGlobal).toHaveBeenCalledTimes(1);
    expect(fetchEffective).toHaveBeenCalledTimes(3);
  });

  it("put() installs a policy without going through fetch", async () => {
    const fetchGlobal = vi.fn(async () => undefined);
    const resolver = new PolicyResolver({ fetchGlobal });
    resolver.put("ag_a", null, { mode: "muted", keywords: [] });
    const p = await resolver.resolve("ag_a", null);
    expect(p.mode).toBe("muted");
    expect(fetchGlobal).not.toHaveBeenCalled();
  });

  it("forces DM rooms (rm_dm_*) to mode=always even if cached muted", async () => {
    const resolver = new PolicyResolver({ fetchGlobal: async () => undefined });
    resolver.put("ag_a", "rm_dm_xyz", { mode: "muted", keywords: [] });
    const p = await resolver.resolve("ag_a", "rm_dm_xyz");
    expect(p.mode).toBe("always");
  });

  it("falls back to defaults when fetch throws", async () => {
    const resolver = new PolicyResolver({
      fetchGlobal: async () => {
        throw new Error("boom");
      },
    });
    const p = await resolver.resolve("ag_a", null);
    expect(p.mode).toBe("always");
  });

  it("falls back to the cached global when resolving a room with no override", async () => {
    // Regression: prior to the room→global fallback, group messages
    // collapsed to mode=always whenever the daemon had no fetchEffective
    // wired (the default state), silently breaking global mention_only/muted.
    const resolver = new PolicyResolver({ fetchGlobal: async () => undefined });
    resolver.put("ag_a", null, { mode: "mention_only", keywords: [] });
    const p = await resolver.resolve("ag_a", "rm_1");
    expect(p.mode).toBe("mention_only");
  });

  it("per-room override wins over the cached global", async () => {
    const resolver = new PolicyResolver({ fetchGlobal: async () => undefined });
    resolver.put("ag_a", null, { mode: "always", keywords: [] });
    resolver.put("ag_a", "rm_1", { mode: "muted", keywords: [] });
    const p = await resolver.resolve("ag_a", "rm_1");
    expect(p.mode).toBe("muted");
    // Other rooms still inherit the global.
    expect((await resolver.resolve("ag_a", "rm_2")).mode).toBe("always");
  });

  it("invalidate(agent, room) drops the override and falls back to the cached global", async () => {
    const resolver = new PolicyResolver({ fetchGlobal: async () => undefined });
    resolver.put("ag_a", null, { mode: "mention_only", keywords: [] });
    resolver.put("ag_a", "rm_1", { mode: "muted", keywords: [] });
    expect((await resolver.resolve("ag_a", "rm_1")).mode).toBe("muted");
    resolver.invalidate("ag_a", "rm_1");
    expect((await resolver.resolve("ag_a", "rm_1")).mode).toBe("mention_only");
  });

  it("global update via put propagates to inheriting rooms without invalidation", async () => {
    const resolver = new PolicyResolver({ fetchGlobal: async () => undefined });
    resolver.put("ag_a", null, { mode: "always", keywords: [] });
    expect((await resolver.resolve("ag_a", "rm_1")).mode).toBe("always");
    // Hub fires policy_updated with new global policy → daemon does put().
    resolver.put("ag_a", null, { mode: "muted", keywords: [] });
    expect((await resolver.resolve("ag_a", "rm_1")).mode).toBe("muted");
  });

  it("expires cached entries after ttlMs", async () => {
    const fetchGlobal = vi.fn(async () => ({ mode: "muted", keywords: [] }) as AttentionPolicy);
    const resolver = new PolicyResolver({ fetchGlobal, ttlMs: 1 });
    await resolver.resolve("ag_a", null);
    await new Promise((r) => setTimeout(r, 5));
    await resolver.resolve("ag_a", null);
    expect(fetchGlobal).toHaveBeenCalledTimes(2);
  });
});
