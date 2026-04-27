import { describe, expect, it, vi } from "vitest";
import type { DaemonConfig } from "../config.js";
import {
  BOTCORD_CHANNEL_TYPE,
  buildManagedRoutes,
  toGatewayConfig,
} from "../daemon-config-map.js";
import { agentWorkspaceDir } from "../agent-workspace.js";
import type { GatewayRoute } from "../gateway/index.js";

function baseConfig(partial: Partial<DaemonConfig> = {}): DaemonConfig {
  return {
    agentId: "ag_daemon",
    defaultRoute: { adapter: "claude-code", cwd: "/home/alice" },
    routes: [],
    streamBlocks: true,
    ...partial,
  };
}

describe("toGatewayConfig", () => {
  it("translates a minimal (legacy agentId) daemon config into a single-channel gateway config keyed by agentId", () => {
    const gw = toGatewayConfig(baseConfig());
    expect(gw.channels).toHaveLength(1);
    expect(gw.channels[0]).toEqual({
      id: "ag_daemon",
      type: BOTCORD_CHANNEL_TYPE,
      accountId: "ag_daemon",
      agentId: "ag_daemon",
    });
    expect(gw.defaultRoute).toEqual({
      runtime: "claude-code",
      cwd: "/home/alice",
      extraArgs: undefined,
      trustLevel: undefined,
    });
    expect(gw.routes).toEqual([]);
    expect(gw.streamBlocks).toBe(true);
  });

  it("maps route.match.roomId to conversationId without auto-injecting channel", () => {
    const cfg = baseConfig({
      routes: [
        {
          match: { roomId: "rm_abc" },
          adapter: "claude-code",
          cwd: "/work",
        },
      ],
    });
    const gw = toGatewayConfig(cfg);
    expect(gw.routes).toHaveLength(1);
    expect(gw.routes![0].match).toEqual({
      conversationId: "rm_abc",
    });
    expect(gw.routes![0].match?.channel).toBeUndefined();
    expect(gw.routes![0].runtime).toBe("claude-code");
    expect(gw.routes![0].cwd).toBe("/work");
  });

  it("maps route.match.roomPrefix to conversationPrefix without auto-injecting channel", () => {
    const cfg = baseConfig({
      routes: [
        {
          match: { roomPrefix: "rm_oc_" },
          adapter: "claude-code",
          cwd: "/work",
        },
      ],
    });
    const gw = toGatewayConfig(cfg);
    expect(gw.routes![0].match).toEqual({
      conversationPrefix: "rm_oc_",
    });
    expect(gw.routes![0].match?.channel).toBeUndefined();
  });

  it("does not inject queueMode for rm_oc_ prefix routes (dispatcher default wins via direct kind)", () => {
    const cfg = baseConfig({
      routes: [
        {
          match: { roomPrefix: "rm_oc_" },
          adapter: "claude-code",
          cwd: "/work",
        },
      ],
    });
    const gw = toGatewayConfig(cfg);
    expect(gw.routes![0].queueMode).toBeUndefined();
  });

  it("does not inject queueMode for a concrete rm_oc_* roomId route", () => {
    const cfg = baseConfig({
      routes: [
        {
          match: { roomId: "rm_oc_abc123" },
          adapter: "claude-code",
          cwd: "/work",
        },
      ],
    });
    const gw = toGatewayConfig(cfg);
    expect(gw.routes![0].queueMode).toBeUndefined();
  });

  it("leaves queueMode undefined for non-owner-chat routes (dispatcher default wins)", () => {
    const cfg = baseConfig({
      routes: [
        {
          match: { roomPrefix: "rm_share_" },
          adapter: "claude-code",
          cwd: "/work",
        },
      ],
    });
    const gw = toGatewayConfig(cfg);
    expect(gw.routes![0].queueMode).toBeUndefined();
    expect(gw.defaultRoute.queueMode).toBeUndefined();
  });

  it("maps trustLevel owner → owner and untrusted → public when present", () => {
    const cfg = baseConfig({
      defaultRoute: {
        adapter: "claude-code",
        cwd: "/home",
        // Untyped extension — daemon config doesn't require trustLevel, but
        // callers may pass it through. Cast to access the compat surface.
        ...({ trustLevel: "owner" } as Record<string, unknown>),
      } as DaemonConfig["defaultRoute"],
      routes: [
        {
          match: { roomId: "rm_peer" },
          adapter: "claude-code",
          cwd: "/x",
          ...({ trustLevel: "untrusted" } as Record<string, unknown>),
        } as DaemonConfig["routes"][number],
      ],
    });
    const gw = toGatewayConfig(cfg);
    expect(gw.defaultRoute.trustLevel).toBe("owner");
    expect(gw.routes![0].trustLevel).toBe("public");
  });

  it("propagates extraArgs verbatim on default and route entries", () => {
    const cfg = baseConfig({
      defaultRoute: {
        adapter: "claude-code",
        cwd: "/home",
        extraArgs: ["--permission-mode", "plan"],
      },
      routes: [
        {
          match: { roomId: "rm_x" },
          adapter: "codex",
          cwd: "/proj",
          extraArgs: ["--flag"],
        },
      ],
    });
    const gw = toGatewayConfig(cfg);
    expect(gw.defaultRoute.extraArgs).toEqual(["--permission-mode", "plan"]);
    expect(gw.routes![0].extraArgs).toEqual(["--flag"]);
  });

  it("propagates streamBlocks verbatim (true and false)", () => {
    expect(toGatewayConfig(baseConfig({ streamBlocks: true })).streamBlocks).toBe(true);
    expect(toGatewayConfig(baseConfig({ streamBlocks: false })).streamBlocks).toBe(false);
  });

  it("passes through new match fields (accountId, senderId, kind, mentioned, channel)", () => {
    const cfg = baseConfig({
      routes: [
        {
          match: {
            channel: "botcord",
            accountId: "ag_account",
            senderId: "ag_sender",
            conversationKind: "direct",
            mentioned: true,
          },
          adapter: "claude-code",
          cwd: "/work",
        },
      ],
    });
    const gw = toGatewayConfig(cfg);
    expect(gw.routes![0].match).toEqual({
      channel: "botcord",
      accountId: "ag_account",
      senderId: "ag_sender",
      conversationKind: "direct",
      mentioned: true,
    });
  });

  it("prefers conversationId over legacy roomId when both are present", () => {
    const cfg = baseConfig({
      routes: [
        {
          match: { roomId: "rm_legacy", conversationId: "rm_canonical" },
          adapter: "claude-code",
          cwd: "/work",
        },
      ],
    });
    const gw = toGatewayConfig(cfg);
    expect(gw.routes![0].match?.conversationId).toBe("rm_canonical");
  });

  it("prefers conversationPrefix over legacy roomPrefix when both are present", () => {
    const cfg = baseConfig({
      routes: [
        {
          match: {
            roomPrefix: "rm_oc_",
            conversationPrefix: "rm_share_",
          },
          adapter: "claude-code",
          cwd: "/work",
        },
      ],
    });
    const gw = toGatewayConfig(cfg);
    expect(gw.routes![0].match?.conversationPrefix).toBe("rm_share_");
  });

  it("allows overriding the channel binding for multi-channel configs", () => {
    const cfg = baseConfig({
      routes: [
        {
          match: { channel: "telegram", conversationPrefix: "tg_" },
          adapter: "claude-code",
          cwd: "/work",
        },
      ],
    });
    const gw = toGatewayConfig(cfg);
    expect(gw.routes![0].match?.channel).toBe("telegram");
  });

  it("emits one channel per id when `agents` carries multiple entries", () => {
    // Drop the legacy agentId so `baseConfig` doesn't hand us both shapes.
    const cfg = baseConfig({
      agentId: undefined,
      agents: ["ag_one", "ag_two"],
    });
    const gw = toGatewayConfig(cfg);
    expect(gw.channels).toHaveLength(2);
    expect(gw.channels[0]).toEqual({
      id: "ag_one",
      type: BOTCORD_CHANNEL_TYPE,
      accountId: "ag_one",
      agentId: "ag_one",
    });
    expect(gw.channels[1]).toEqual({
      id: "ag_two",
      type: BOTCORD_CHANNEL_TYPE,
      accountId: "ag_two",
      agentId: "ag_two",
    });
  });

  it("prefers `agents` when both `agents` and legacy `agentId` are present", () => {
    // agentId here isn't in agents — the resolver warns on stderr and
    // proceeds with agents. We silence the warning to keep test output clean.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const cfg = baseConfig({
        agentId: "ag_legacy",
        agents: ["ag_one", "ag_two"],
      });
      const gw = toGatewayConfig(cfg);
      expect(gw.channels.map((c) => c.id)).toEqual(["ag_one", "ag_two"]);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("deduplicates repeated agent ids while preserving order", () => {
    const cfg = baseConfig({
      agentId: undefined,
      agents: ["ag_one", "ag_two", "ag_one"],
    });
    const gw = toGatewayConfig(cfg);
    expect(gw.channels.map((c) => c.id)).toEqual(["ag_one", "ag_two"]);
  });

  it("throws when neither `agents` nor `agentId` is present (and no explicit agentIds override)", () => {
    const cfg = baseConfig({ agentId: undefined });
    // baseConfig leaves `agents` undefined, so resolveAgentIds should reject
    // when no opts.agentIds is supplied. (P1 callers pass boot agents in.)
    expect(() => toGatewayConfig(cfg)).toThrow(/missing agents/);
  });

  it("accepts an explicit agentIds override (P1: boot agents injected by daemon)", () => {
    const cfg = baseConfig({ agentId: undefined });
    const gw = toGatewayConfig(cfg, { agentIds: ["ag_discovered"] });
    expect(gw.channels.map((c) => c.id)).toEqual(["ag_discovered"]);
  });

  it("emits zero channels when the injected agentIds list is empty", () => {
    // When credentials discovery finds nothing the daemon still boots with
    // no channels — `toGatewayConfig` must not throw in that case.
    const cfg = baseConfig({ agentId: undefined });
    const gw = toGatewayConfig(cfg, { agentIds: [] });
    expect(gw.channels).toEqual([]);
  });

  it("routes user-authored cfg.routes[] through to GatewayConfig.routes unchanged", () => {
    const cfg = baseConfig({
      agentId: undefined,
      agents: ["ag_one"],
      routes: [
        { match: { roomPrefix: "rm_oc_" }, adapter: "claude-code", cwd: "/work" },
      ],
    });
    const gw = toGatewayConfig(cfg, {
      agentIds: ["ag_one"],
      agentRuntimes: { ag_one: { runtime: "codex", cwd: "/home/alice/ag_one" } },
    });
    // User route stays in `routes[]` exactly as translated from `cfg.routes`.
    expect(gw.routes).toHaveLength(1);
    expect(gw.routes![0].match).toEqual({ conversationPrefix: "rm_oc_" });
    // Synthesized per-agent route lives in `managedRoutes`, not `routes`.
    expect(gw.managedRoutes).toEqual([
      {
        match: { accountId: "ag_one" },
        runtime: "codex",
        cwd: "/home/alice/ag_one",
      },
    ]);
  });

  it("synthesizes managed routes into GatewayConfig.managedRoutes, not GatewayConfig.routes", () => {
    const cfg = baseConfig({
      agentId: undefined,
      agents: ["ag_one", "ag_two"],
    });
    const gw = toGatewayConfig(cfg, {
      agentIds: ["ag_one", "ag_two"],
      agentRuntimes: {
        ag_one: { runtime: "codex", cwd: "/home/alice/ag_one" },
        // ag_two deliberately missing — should still get a managed route.
      },
    });
    expect(gw.routes).toEqual([]);
    expect(gw.managedRoutes).toHaveLength(2);
    expect(gw.managedRoutes![0]).toEqual({
      match: { accountId: "ag_one" },
      runtime: "codex",
      cwd: "/home/alice/ag_one",
    });
    expect(gw.managedRoutes![1]).toEqual({
      match: { accountId: "ag_two" },
      runtime: "claude-code",
      cwd: agentWorkspaceDir("ag_two"),
    });
  });
});

describe("buildManagedRoutes", () => {
  const defaultRoute: GatewayRoute = {
    runtime: "claude-code",
    cwd: "/home/default",
  };

  it("uses agentRuntimes[id].cwd when set", () => {
    const map = buildManagedRoutes(
      ["ag_one"],
      { ag_one: { runtime: "codex", cwd: "/custom/ag_one" } },
      defaultRoute,
    );
    expect(map.get("ag_one")).toEqual({
      match: { accountId: "ag_one" },
      runtime: "codex",
      cwd: "/custom/ag_one",
    });
  });

  it("falls back to agentWorkspaceDir(id) when meta has no cwd", () => {
    const map = buildManagedRoutes(
      ["ag_one"],
      { ag_one: { runtime: "codex" } },
      defaultRoute,
    );
    expect(map.get("ag_one")?.cwd).toBe(agentWorkspaceDir("ag_one"));
  });

  it("falls back to defaultRoute.runtime when meta has no runtime (behavior change from pre-plan guard)", () => {
    // Previously the synthesized route was only emitted when meta.runtime
    // was truthy; agents without a cached runtime were silently skipped.
    // Plan §10 makes the synthesis universal so every agent lands in its
    // own workspace by default.
    const map = buildManagedRoutes(["ag_one"], {}, defaultRoute);
    expect(map.get("ag_one")).toEqual({
      match: { accountId: "ag_one" },
      runtime: "claude-code",
      cwd: agentWorkspaceDir("ag_one"),
    });
  });

  it("preserves agentIds insertion order in the returned map", () => {
    const map = buildManagedRoutes(
      ["ag_b", "ag_a", "ag_c"],
      {},
      defaultRoute,
    );
    expect(Array.from(map.keys())).toEqual(["ag_b", "ag_a", "ag_c"]);
  });

  it("emits an empty map when agentIds is empty", () => {
    const map = buildManagedRoutes([], {}, defaultRoute);
    expect(map.size).toBe(0);
  });
});

describe("openclawGateways resolution", () => {
  it("resolves a route gateway profile name into ResolvedOpenclawGateway", () => {
    const cfg = baseConfig({
      defaultRoute: { adapter: "claude-code", cwd: "/home/alice" },
      openclawGateways: [
        { name: "local", url: "ws://127.0.0.1:1", token: "t1", defaultAgent: "main" },
      ],
      routes: [
        { match: { conversationId: "rm_x" }, adapter: "openclaw-acp", cwd: "/home/alice", gateway: "local" },
      ],
    });
    const gw = toGatewayConfig(cfg);
    expect(gw.routes[0].gateway).toEqual({
      name: "local",
      url: "ws://127.0.0.1:1",
      token: "t1",
      openclawAgent: "main",
    });
  });

  it("route.openclawAgent overrides profile.defaultAgent", () => {
    const cfg = baseConfig({
      openclawGateways: [{ name: "p1", url: "ws://x", defaultAgent: "main" }],
      routes: [{ match: {}, adapter: "openclaw-acp", cwd: "/home/alice", gateway: "p1", openclawAgent: "design" }],
    });
    const gw = toGatewayConfig(cfg);
    expect(gw.routes[0].gateway?.openclawAgent).toBe("design");
  });

  it("buildManagedRoutes uses credentials openclawGateway / openclawAgent", () => {
    const cfg = baseConfig({
      agents: ["ag_one"],
      openclawGateways: [{ name: "p1", url: "ws://x", defaultAgent: "main" }],
    });
    const gw = toGatewayConfig(cfg, {
      agentIds: ["ag_one"],
      agentRuntimes: { ag_one: { runtime: "openclaw-acp", openclawGateway: "p1", openclawAgent: "qa" } },
    });
    const managed = gw.managedRoutes?.find((r) => r.match?.accountId === "ag_one");
    expect(managed?.runtime).toBe("openclaw-acp");
    expect(managed?.gateway?.name).toBe("p1");
    expect(managed?.gateway?.openclawAgent).toBe("qa");
  });

  it("buildManagedRoutes skips an openclaw-acp managed route when its gateway is unknown", () => {
    const cfg = baseConfig({
      agents: ["ag_one"],
      openclawGateways: [{ name: "p1", url: "ws://x" }],
    });
    const gw = toGatewayConfig(cfg, {
      agentIds: ["ag_one"],
      agentRuntimes: { ag_one: { runtime: "openclaw-acp", openclawGateway: "missing" } },
    });
    expect(gw.managedRoutes).toEqual([]);
  });
});

