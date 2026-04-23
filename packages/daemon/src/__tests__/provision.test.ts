import { beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted mock for `../config.js` so reloadConfig / setRoute don't read the
// real `~/.botcord/daemon/config.json`. Bound to `mockState` so each test
// can rewrite the in-memory config and observe saves.
const mockState = {
  cfg: {
    defaultRoute: { adapter: "claude-code", cwd: "/tmp" },
    routes: [],
    streamBlocks: true,
  } as Record<string, unknown>,
  saved: [] as Array<Record<string, unknown>>,
};

vi.mock("../config.js", async () => {
  const actual = await vi.importActual<typeof import("../config.js")>("../config.js");
  return {
    ...actual,
    loadConfig: () => JSON.parse(JSON.stringify(mockState.cfg)) as Record<string, unknown>,
    saveConfig: (next: Record<string, unknown>) => {
      mockState.cfg = JSON.parse(JSON.stringify(next)) as Record<string, unknown>;
      mockState.saved.push(JSON.parse(JSON.stringify(next)) as Record<string, unknown>);
    },
  };
});

const {
  addAgentToConfig,
  removeAgentFromConfig,
  reloadConfig,
  setRoute,
  createProvisioner,
} = await import("../provision.js");
const { CONTROL_FRAME_TYPES } = await import("@botcord/protocol-core");
import type { DaemonConfig } from "../config.js";
import type { GatewayChannelConfig, GatewayRuntimeSnapshot } from "../gateway/index.js";

beforeEach(() => {
  mockState.cfg = {
    defaultRoute: { adapter: "claude-code", cwd: "/tmp" },
    routes: [],
    streamBlocks: true,
  };
  mockState.saved = [];
});

function baseConfig(overrides: Partial<DaemonConfig> = {}): DaemonConfig {
  return {
    defaultRoute: { adapter: "claude-code", cwd: "/tmp" },
    routes: [],
    streamBlocks: true,
    ...overrides,
  };
}

describe("addAgentToConfig / removeAgentFromConfig", () => {
  it("adds a new agent to an empty config", () => {
    const cfg = baseConfig();
    const next = addAgentToConfig(cfg, "ag_a");
    expect(next?.agents).toEqual(["ag_a"]);
  });

  it("no-ops when the agent is already present", () => {
    const cfg = baseConfig({ agents: ["ag_a"] });
    expect(addAgentToConfig(cfg, "ag_a")).toBeNull();
  });

  it("absorbs a legacy scalar agentId into the new agents array", () => {
    const cfg = baseConfig({ agentId: "ag_legacy" });
    const next = addAgentToConfig(cfg, "ag_new");
    expect(next?.agents).toEqual(["ag_legacy", "ag_new"]);
    expect(next?.agentId).toBeUndefined();
  });

  it("removes an agent from the list", () => {
    const cfg = baseConfig({ agents: ["ag_a", "ag_b"] });
    const next = removeAgentFromConfig(cfg, "ag_a");
    expect(next?.agents).toEqual(["ag_b"]);
  });

  it("drops the legacy scalar if it matches the removed agent", () => {
    const cfg = baseConfig({ agentId: "ag_legacy" });
    const next = removeAgentFromConfig(cfg, "ag_legacy");
    expect(next?.agentId).toBeUndefined();
    expect(next?.agents).toEqual([]);
  });

  it("no-ops when the agent isn't configured", () => {
    const cfg = baseConfig({ agents: ["ag_a"] });
    expect(removeAgentFromConfig(cfg, "ag_nope")).toBeNull();
  });
});

interface FakeGateway {
  addChannel: ReturnType<typeof vi.fn>;
  removeChannel: ReturnType<typeof vi.fn>;
  snapshot: () => GatewayRuntimeSnapshot;
}

function makeFakeGateway(initialChannelIds: string[] = []): FakeGateway {
  const channels = new Set(initialChannelIds);
  return {
    addChannel: vi.fn(async (cfg: GatewayChannelConfig) => {
      channels.add(cfg.id);
    }),
    removeChannel: vi.fn(async (id: string) => {
      channels.delete(id);
    }),
    snapshot: (): GatewayRuntimeSnapshot => ({
      channels: Object.fromEntries(
        [...channels].map((id) => [
          id,
          {
            channel: id,
            accountId: id,
            running: true,
            connected: true,
            lastStartAt: 1700000000000,
          },
        ]),
      ),
      turns: {},
    }),
  };
}

describe("reload_config handler", () => {
  it("adds agents listed in config but missing from gateway", async () => {
    mockState.cfg = {
      defaultRoute: { adapter: "claude-code", cwd: "/tmp" },
      routes: [],
      streamBlocks: true,
      agents: ["ag_a", "ag_b"],
    };
    const gw = makeFakeGateway(["ag_a"]);
    const res = await reloadConfig({ gateway: gw as unknown as Parameters<typeof reloadConfig>[0]["gateway"] });
    expect(res.added).toEqual(["ag_b"]);
    expect(res.removed).toEqual([]);
    expect(gw.addChannel).toHaveBeenCalledOnce();
    const addArg = gw.addChannel.mock.calls[0][0] as GatewayChannelConfig;
    expect(addArg.id).toBe("ag_b");
    expect(addArg.type).toBe("botcord");
  });

  it("removes channels not listed in config", async () => {
    mockState.cfg = {
      defaultRoute: { adapter: "claude-code", cwd: "/tmp" },
      routes: [],
      streamBlocks: true,
      agents: ["ag_a"],
    };
    const gw = makeFakeGateway(["ag_a", "ag_stale"]);
    const res = await reloadConfig({ gateway: gw as unknown as Parameters<typeof reloadConfig>[0]["gateway"] });
    expect(res.removed).toEqual(["ag_stale"]);
    expect(res.added).toEqual([]);
    expect(gw.removeChannel).toHaveBeenCalledWith("ag_stale", "reload_config");
  });

  it("returns reloaded:true with empty diffs when in sync", async () => {
    mockState.cfg = {
      defaultRoute: { adapter: "claude-code", cwd: "/tmp" },
      routes: [],
      streamBlocks: true,
      agents: ["ag_a"],
    };
    const gw = makeFakeGateway(["ag_a"]);
    const res = await reloadConfig({ gateway: gw as unknown as Parameters<typeof reloadConfig>[0]["gateway"] });
    expect(res).toEqual({ reloaded: true, added: [], removed: [] });
  });
});

describe("list_agents handler", () => {
  it("returns running channels with status + lastMessageAt", async () => {
    const gw = makeFakeGateway(["ag_a", "ag_b"]);
    const provisioner = createProvisioner({
      gateway: gw as unknown as Parameters<typeof createProvisioner>[0]["gateway"],
    });
    const ack = await provisioner({
      id: "req_1",
      type: CONTROL_FRAME_TYPES.LIST_AGENTS,
    });
    expect(ack.ok).toBe(true);
    const result = ack.result as {
      agents: Array<{ id: string; name: string; online: boolean; status: string }>;
    };
    const ids = result.agents.map((a) => a.id).sort();
    expect(ids).toEqual(["ag_a", "ag_b"]);
    for (const a of result.agents) {
      expect(a.status).toBe("running");
      expect(a.online).toBe(true);
      expect(a.name).toBe(a.id);
    }
  });
});

describe("set_route handler", () => {
  it("appends a new route pinned to the agent", () => {
    const res = setRoute({
      agentId: "ag_a",
      route: { adapter: "claude-code", cwd: process.env.HOME ?? "/tmp" },
    });
    expect(res.ok).toBe(true);
    expect(res.inserted).toBe(true);
    expect(mockState.saved.length).toBeGreaterThan(0);
    const saved = mockState.saved[mockState.saved.length - 1] as unknown as DaemonConfig;
    expect(saved.routes).toHaveLength(1);
    expect(saved.routes[0].match.accountId).toBe("ag_a");
    expect(saved.routes[0].adapter).toBe("claude-code");
  });

  it("replaces the agent-only route in place on second call", () => {
    setRoute({ agentId: "ag_a", route: { adapter: "claude-code", cwd: process.env.HOME ?? "/tmp" } });
    const res2 = setRoute({
      agentId: "ag_a",
      route: { adapter: "claude-code", cwd: process.env.HOME ?? "/tmp", extraArgs: ["--debug"] },
    });
    expect(res2.inserted).toBe(false);
    const saved = mockState.saved[mockState.saved.length - 1] as unknown as DaemonConfig;
    expect(saved.routes).toHaveLength(1);
    expect(saved.routes[0].extraArgs).toEqual(["--debug"]);
  });

  it("forces match.accountId to the agentId even when callers omit it", () => {
    setRoute({
      agentId: "ag_x",
      route: { adapter: "claude-code", cwd: process.env.HOME ?? "/tmp", match: { conversationPrefix: "rm_oc_" } },
    });
    const saved = mockState.saved[mockState.saved.length - 1] as unknown as DaemonConfig;
    expect(saved.routes[0].match.accountId).toBe("ag_x");
    expect(saved.routes[0].match.conversationPrefix).toBe("rm_oc_");
  });

  it("rejects routes whose cwd is outside $HOME", () => {
    expect(() =>
      setRoute({ agentId: "ag_a", route: { adapter: "claude-code", cwd: "/etc/passwd-dir" } }),
    ).toThrow(/outside the user home/);
  });

  it("rejects unknown adapters", () => {
    expect(() =>
      setRoute({ agentId: "ag_a", route: { adapter: "totally-fake", cwd: process.env.HOME ?? "/tmp" } }),
    ).toThrow(/unknown adapter/);
  });

  it("requires agentId and route", () => {
    expect(() => setRoute({})).toThrow(/agentId/);
    expect(() => setRoute({ agentId: "ag_a" })).toThrow(/route/);
  });

  it("accepts the contract's {agentId, pattern} shape", () => {
    // Use the daemon's default cwd ($HOME) so safe-cwd validation passes.
    mockState.cfg = {
      defaultRoute: { adapter: "claude-code", cwd: process.env.HOME ?? "/tmp" },
      routes: [],
      streamBlocks: true,
    };
    const res = setRoute({ agentId: "ag_a", pattern: "rm_oc_" });
    expect(res.ok).toBe(true);
    expect(res.inserted).toBe(true);
    const saved = mockState.saved[mockState.saved.length - 1] as unknown as DaemonConfig;
    expect(saved.routes[0].match.accountId).toBe("ag_a");
    expect(saved.routes[0].match.conversationPrefix).toBe("rm_oc_");
  });
});

// ---------------------------------------------------------------------------
// provision_agent runtime / cwd persistence
// ---------------------------------------------------------------------------

describe("provision_agent handler writes runtime + cwd", () => {
  it("persists runtime and cwd from the credentials envelope to the credentials file", async () => {
    const os = await import("node:os");
    const fs = await import("node:fs");
    const nodePath = await import("node:path");

    // Redirect $HOME so writeCredentialsFile lands in a sandbox.
    const tmp = fs.mkdtempSync(nodePath.join(os.tmpdir(), "daemon-provision-"));
    const prevHome = process.env.HOME;
    process.env.HOME = tmp;
    try {
      const gw = makeFakeGateway();
      const provisioner = createProvisioner({
        gateway: gw as unknown as Parameters<typeof createProvisioner>[0]["gateway"],
      });

      // A valid 32-byte Ed25519 seed → deterministic keypair. Any fresh
      // 32-byte b64 works; writeCredentialsFile cross-checks publicKey if
      // provided. Here we let the provisioner derive it from privateKey.
      const privateKey = Buffer.alloc(32, 7).toString("base64");

      const ack = await provisioner({
        id: "req_prov",
        type: CONTROL_FRAME_TYPES.PROVISION_AGENT,
        params: {
          runtime: "claude-code",
          cwd: tmp,
          credentials: {
            agentId: "ag_runtime",
            keyId: "k_runtime",
            privateKey,
            hubUrl: "https://hub.example",
            displayName: "writer",
            runtime: "claude-code",
            cwd: tmp,
          },
        },
      });

      expect(ack.ok).toBe(true);
      expect(gw.addChannel).toHaveBeenCalledOnce();

      // File written with runtime + cwd fields preserved.
      const credFile = nodePath.join(tmp, ".botcord", "credentials", "ag_runtime.json");
      const raw = fs.readFileSync(credFile, "utf8");
      const saved = JSON.parse(raw) as Record<string, unknown>;
      expect(saved.runtime).toBe("claude-code");
      expect(saved.cwd).toBe(tmp);
      expect(saved.hubUrl).toBe("https://hub.example");
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rejects unknown runtime ids before touching disk", async () => {
    const gw = makeFakeGateway();
    const provisioner = createProvisioner({
      gateway: gw as unknown as Parameters<typeof createProvisioner>[0]["gateway"],
    });
    const privateKey = Buffer.alloc(32, 9).toString("base64");
    await expect(
      provisioner({
        id: "req_bad",
        type: CONTROL_FRAME_TYPES.PROVISION_AGENT,
        params: {
          runtime: "totally-fake",
          credentials: {
            agentId: "ag_bad",
            keyId: "k_bad",
            privateKey,
            hubUrl: "https://hub.example",
          },
        },
      }),
    ).rejects.toThrow(/unknown runtime/);
    expect(gw.addChannel).not.toHaveBeenCalled();
  });

  it("accepts the deprecated `adapter` alias from older Hub builds", async () => {
    const os = await import("node:os");
    const fs = await import("node:fs");
    const nodePath = await import("node:path");
    const tmp = fs.mkdtempSync(nodePath.join(os.tmpdir(), "daemon-provision-"));
    const prevHome = process.env.HOME;
    process.env.HOME = tmp;
    try {
      const gw = makeFakeGateway();
      const provisioner = createProvisioner({
        gateway: gw as unknown as Parameters<typeof createProvisioner>[0]["gateway"],
      });
      const privateKey = Buffer.alloc(32, 11).toString("base64");
      const ack = await provisioner({
        id: "req_alias",
        type: CONTROL_FRAME_TYPES.PROVISION_AGENT,
        params: {
          adapter: "claude-code",
          credentials: {
            agentId: "ag_alias",
            keyId: "k_alias",
            privateKey,
            hubUrl: "https://hub.example",
          },
        },
      });
      expect(ack.ok).toBe(true);
      const credFile = nodePath.join(tmp, ".botcord", "credentials", "ag_alias.json");
      const saved = JSON.parse(fs.readFileSync(credFile, "utf8")) as Record<string, unknown>;
      expect(saved.runtime).toBe("claude-code");
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
