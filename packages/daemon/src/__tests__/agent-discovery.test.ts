import { describe, expect, it } from "vitest";
import type { Stats } from "node:fs";
import { discoverAgentCredentials, resolveBootAgents } from "../agent-discovery.js";
import type { DaemonConfig } from "../config.js";

function fakeStat(mtimeMs: number): Stats {
  return { mtimeMs } as unknown as Stats;
}

function fakeCreds(agentId: string, extra: Record<string, unknown> = {}) {
  return {
    version: 1 as const,
    hubUrl: "https://hub.example.com",
    agentId,
    keyId: "k_1",
    privateKey: "priv",
    publicKey: "pub",
    savedAt: new Date().toISOString(),
    ...extra,
  };
}

describe("discoverAgentCredentials", () => {
  it("returns an empty result when the credentials directory is missing", () => {
    const res = discoverAgentCredentials({
      credentialsDir: "/no/such/dir",
      readDir: () => {
        const err = new Error("ENOENT") as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      },
      stat: () => fakeStat(0),
      loadCredentials: () => {
        throw new Error("should not be called");
      },
    });
    expect(res.agents).toEqual([]);
    expect(res.warnings).toEqual([]);
  });

  it("loads valid credential files and returns the internal agentId (not the filename)", () => {
    const res = discoverAgentCredentials({
      credentialsDir: "/creds",
      readDir: () => ["wrong-name.json"],
      stat: () => fakeStat(100),
      loadCredentials: () => fakeCreds("ag_internal", { displayName: "Alice" }),
    });
    expect(res.agents).toEqual([
      {
        agentId: "ag_internal",
        credentialsFile: "/creds/wrong-name.json",
        hubUrl: "https://hub.example.com",
        displayName: "Alice",
      },
    ]);
    expect(res.warnings).toEqual([]);
  });

  it("ignores non-JSON files silently", () => {
    const loaded: string[] = [];
    const res = discoverAgentCredentials({
      credentialsDir: "/creds",
      readDir: () => ["ignore.txt", "README", "ag.json"],
      stat: () => fakeStat(1),
      loadCredentials: (f) => {
        loaded.push(f);
        return fakeCreds("ag_one");
      },
    });
    expect(loaded).toEqual(["/creds/ag.json"]);
    expect(res.agents.map((a) => a.agentId)).toEqual(["ag_one"]);
  });

  it("skips invalid credentials and records a warning", () => {
    const res = discoverAgentCredentials({
      credentialsDir: "/creds",
      readDir: () => ["bad.json", "good.json"],
      stat: () => fakeStat(1),
      loadCredentials: (f) => {
        if (f.endsWith("bad.json")) throw new Error("missing hubUrl");
        return fakeCreds("ag_good");
      },
    });
    expect(res.agents.map((a) => a.agentId)).toEqual(["ag_good"]);
    expect(res.warnings.some((w) => w.includes("invalid credentials") && w.includes("bad.json"))).toBe(true);
  });

  it("prefers the newer mtime on duplicate agentIds", () => {
    const res = discoverAgentCredentials({
      credentialsDir: "/creds",
      readDir: () => ["a.json", "b.json"],
      stat: (p) => (p.endsWith("b.json") ? fakeStat(200) : fakeStat(100)),
      loadCredentials: () => fakeCreds("ag_dup"),
    });
    expect(res.agents).toHaveLength(1);
    expect(res.agents[0].credentialsFile).toBe("/creds/b.json");
    expect(res.warnings.some((w) => w.includes("duplicate agentId"))).toBe(true);
  });

  it("falls back to lexical order when mtimes tie", () => {
    const res = discoverAgentCredentials({
      credentialsDir: "/creds",
      readDir: () => ["z.json", "a.json"],
      stat: () => fakeStat(42),
      loadCredentials: () => fakeCreds("ag_dup"),
    });
    expect(res.agents).toHaveLength(1);
    // Sorted lexically first wins when mtimes are equal.
    expect(res.agents[0].credentialsFile).toBe("/creds/a.json");
  });
});

describe("resolveBootAgents", () => {
  function cfg(overrides: Partial<DaemonConfig> = {}): DaemonConfig {
    return {
      defaultRoute: { adapter: "claude-code", cwd: "/home/a" },
      routes: [],
      streamBlocks: true,
      ...overrides,
    };
  }

  it("uses explicit `agents` list and derives default credential paths", () => {
    const res = resolveBootAgents(cfg({ agents: ["ag_one", "ag_two"] }));
    expect(res.source).toBe("config");
    expect(res.agents).toHaveLength(2);
    expect(res.agents[0].agentId).toBe("ag_one");
    expect(res.agents[0].credentialsFile).toContain("ag_one.json");
    expect(res.warnings).toEqual([]);
  });

  it("falls back to discovery when no explicit list is present", () => {
    const res = resolveBootAgents(cfg(), {
      credentialsDir: "/creds",
      readDir: () => ["x.json"],
      stat: () => fakeStat(1),
      loadCredentials: () => fakeCreds("ag_discovered"),
    });
    expect(res.source).toBe("credentials");
    expect(res.agents.map((a) => a.agentId)).toEqual(["ag_discovered"]);
    expect(res.agents[0].credentialsFile).toBe("/creds/x.json");
  });

  it("returns an empty agent list (not a throw) when discovery finds nothing", () => {
    const res = resolveBootAgents(cfg(), {
      credentialsDir: "/creds",
      readDir: () => [],
      stat: () => fakeStat(0),
      loadCredentials: () => {
        throw new Error("should not be called");
      },
    });
    expect(res.source).toBe("credentials");
    expect(res.agents).toEqual([]);
  });

  it("honors cfg.agentDiscovery.credentialsDir when discovery runs", () => {
    const calls: string[] = [];
    const res = resolveBootAgents(
      cfg({ agentDiscovery: { credentialsDir: "/custom" } }),
      {
        readDir: (d) => {
          calls.push(d);
          return ["a.json"];
        },
        stat: () => fakeStat(1),
        loadCredentials: () => fakeCreds("ag_c"),
      },
    );
    expect(calls).toEqual(["/custom"]);
    expect(res.credentialsDir).toBe("/custom");
  });
});
