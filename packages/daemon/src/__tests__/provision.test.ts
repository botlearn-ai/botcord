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
  adoptDiscoveredOpenclawAgents,
  removeAgentFromConfig,
  reloadConfig,
  setRoute,
  createProvisioner,
} = await import("../provision.js");
const { CONTROL_FRAME_TYPES } = await import("@botcord/protocol-core");
import type { DaemonConfig } from "../config.js";
import type {
  GatewayChannelConfig,
  GatewayRoute,
  GatewayRuntimeSnapshot,
} from "../gateway/index.js";

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
  upsertManagedRoute: ReturnType<typeof vi.fn>;
  removeManagedRoute: ReturnType<typeof vi.fn>;
  replaceManagedRoutes: ReturnType<typeof vi.fn>;
  listManagedRoutes: () => GatewayRoute[];
  snapshot: () => GatewayRuntimeSnapshot;
}

function makeFakeGateway(initialChannelIds: string[] = []): FakeGateway {
  const channels = new Set(initialChannelIds);
  const managed = new Map<string, GatewayRoute>();
  return {
    addChannel: vi.fn(async (cfg: GatewayChannelConfig) => {
      channels.add(cfg.id);
    }),
    removeChannel: vi.fn(async (id: string) => {
      channels.delete(id);
    }),
    upsertManagedRoute: vi.fn((accountId: string, route: GatewayRoute) => {
      managed.set(accountId, route);
    }),
    removeManagedRoute: vi.fn((accountId: string) => {
      managed.delete(accountId);
    }),
    replaceManagedRoutes: vi.fn((routes: Map<string, GatewayRoute>) => {
      managed.clear();
      for (const [id, route] of routes) managed.set(id, route);
    }),
    listManagedRoutes: (): GatewayRoute[] => Array.from(managed.values()),
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

  it("rebuilds managed routes — legacy credential without cwd gets workspace fallback", async () => {
    const os = await import("node:os");
    const fs = await import("node:fs");
    const nodePath = await import("node:path");
    const { agentWorkspaceDir } = await import("../agent-workspace.js");

    const tmp = fs.mkdtempSync(nodePath.join(os.tmpdir(), "daemon-reload-"));
    const prevHome = process.env.HOME;
    process.env.HOME = tmp;
    try {
      // Plant a legacy credentials file with NO `cwd` field — mimics an
      // agent provisioned before the per-agent-workspace feature shipped.
      const credDir = nodePath.join(tmp, ".botcord", "credentials");
      fs.mkdirSync(credDir, { recursive: true });
      fs.writeFileSync(
        nodePath.join(credDir, "ag_legacy.json"),
        JSON.stringify({
          agentId: "ag_legacy",
          keyId: "k_legacy",
          privateKey: Buffer.alloc(32, 3).toString("base64"),
          hubUrl: "https://hub.example",
          // Deliberately omit `runtime` + `cwd` — the fallback path is
          // what we're exercising.
        }),
      );

      mockState.cfg = {
        defaultRoute: { adapter: "claude-code", cwd: "/tmp" },
        routes: [
          // Operator-authored route for a different accountId — must
          // survive reload untouched (plan §10.5 property).
          { match: { accountId: "ag_user_pinned" }, adapter: "codex", cwd: "/src" },
        ],
        streamBlocks: true,
        agents: ["ag_legacy"],
      };
      const gw = makeFakeGateway(["ag_legacy"]);
      const res = await reloadConfig({
        gateway: gw as unknown as Parameters<typeof reloadConfig>[0]["gateway"],
      });
      expect(res.reloaded).toBe(true);

      expect(gw.replaceManagedRoutes).toHaveBeenCalledOnce();
      const passed = gw.replaceManagedRoutes.mock.calls[0][0] as Map<string, GatewayRoute>;
      const legacy = passed.get("ag_legacy");
      expect(legacy).toBeDefined();
      expect(legacy!.cwd).toBe(agentWorkspaceDir("ag_legacy"));
      expect(legacy!.runtime).toBe("claude-code"); // falls back to defaultRoute.runtime
      // The user-authored route still lives in cfg.routes[] — not duplicated
      // into the managed bucket even if accountIds overlapped.
      expect(passed.has("ag_user_pinned")).toBe(false);
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
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

  it("inherits defaultRoute.extraArgs when caller omits them (mirrors adapter/cwd fallback)", () => {
    mockState.cfg = {
      defaultRoute: {
        adapter: "claude-code",
        cwd: process.env.HOME ?? "/tmp",
        extraArgs: ["--permission-mode", "bypassPermissions"],
      },
      routes: [],
      streamBlocks: true,
    };
    setRoute({ agentId: "ag_new", pattern: "rm_oc_" });
    const saved = mockState.saved[mockState.saved.length - 1] as unknown as DaemonConfig;
    expect(saved.routes[0].extraArgs).toEqual([
      "--permission-mode",
      "bypassPermissions",
    ]);
    // Mutating the saved route must not bleed back into defaultRoute.
    saved.routes[0].extraArgs!.push("--mutated");
    expect(mockState.cfg.defaultRoute).toEqual({
      adapter: "claude-code",
      cwd: process.env.HOME ?? "/tmp",
      extraArgs: ["--permission-mode", "bypassPermissions"],
    });
  });

  it("explicit extraArgs override defaultRoute.extraArgs", () => {
    mockState.cfg = {
      defaultRoute: {
        adapter: "claude-code",
        cwd: process.env.HOME ?? "/tmp",
        extraArgs: ["--permission-mode", "bypassPermissions"],
      },
      routes: [],
      streamBlocks: true,
    };
    setRoute({
      agentId: "ag_new",
      route: { adapter: "claude-code", cwd: process.env.HOME ?? "/tmp", extraArgs: ["--debug"] },
    });
    const saved = mockState.saved[mockState.saved.length - 1] as unknown as DaemonConfig;
    expect(saved.routes[0].extraArgs).toEqual(["--debug"]);
  });

  it("omits extraArgs when neither route nor defaultRoute provide them", () => {
    setRoute({
      agentId: "ag_new",
      route: { adapter: "claude-code", cwd: process.env.HOME ?? "/tmp" },
    });
    const saved = mockState.saved[mockState.saved.length - 1] as unknown as DaemonConfig;
    expect(saved.routes[0]).not.toHaveProperty("extraArgs");
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

// ---------------------------------------------------------------------------
// provision_agent workspace seeding + managed-route hot-add (plan §7, §10.3)
// ---------------------------------------------------------------------------

interface SandboxFixture {
  tmp: string;
  prevHome: string | undefined;
  fs: typeof import("node:fs");
  path: typeof import("node:path");
}

async function withSandboxHome<T>(run: (sbx: SandboxFixture) => Promise<T>): Promise<T> {
  const os = await import("node:os");
  const fs = await import("node:fs");
  const nodePath = await import("node:path");
  const tmp = fs.mkdtempSync(nodePath.join(os.tmpdir(), "daemon-provision-"));
  const prevHome = process.env.HOME;
  process.env.HOME = tmp;
  try {
    return await run({ tmp, prevHome, fs, path: nodePath });
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const SEED_FILES = ["AGENTS.md", "CLAUDE.md", "identity.md", "memory.md", "task.md"];

describe("provision_agent seeds workspace + hot-adds managed route", () => {
  it("defaults cwd to agentWorkspaceDir on the fast path (Hub-supplied credentials)", async () => {
    await withSandboxHome(async ({ tmp, fs, path: nodePath }) => {
      const gw = makeFakeGateway();
      const provisioner = createProvisioner({
        gateway: gw as unknown as Parameters<typeof createProvisioner>[0]["gateway"],
      });
      const privateKey = Buffer.alloc(32, 13).toString("base64");
      const ack = await provisioner({
        id: "req_fast",
        type: CONTROL_FRAME_TYPES.PROVISION_AGENT,
        params: {
          credentials: {
            agentId: "ag_fast",
            keyId: "k_fast",
            privateKey,
            hubUrl: "https://hub.example",
          },
        },
      });
      expect(ack.ok).toBe(true);
      const expectedCwd = nodePath.join(tmp, ".botcord", "agents", "ag_fast", "workspace");
      const credFile = nodePath.join(tmp, ".botcord", "credentials", "ag_fast.json");
      const saved = JSON.parse(fs.readFileSync(credFile, "utf8")) as Record<string, unknown>;
      expect(saved.cwd).toBe(expectedCwd);
      expect(fs.existsSync(expectedCwd)).toBe(true);
      for (const f of SEED_FILES) {
        expect(fs.existsSync(nodePath.join(expectedCwd, f))).toBe(true);
      }
      // State dir and notes/.gitkeep also created.
      expect(fs.existsSync(nodePath.join(tmp, ".botcord", "agents", "ag_fast", "state"))).toBe(true);
      expect(fs.existsSync(nodePath.join(expectedCwd, "notes", ".gitkeep"))).toBe(true);
      // Managed route hot-added.
      const routes = gw.listManagedRoutes();
      expect(routes).toHaveLength(1);
      expect(routes[0].match?.accountId).toBe("ag_fast");
      expect(routes[0].cwd).toBe(expectedCwd);
    });
  });

  it("defaults cwd to agentWorkspaceDir on the slow path (daemon register)", async () => {
    await withSandboxHome(async ({ tmp, fs, path: nodePath }) => {
      // Seed an existing credential so `inferHubUrl` finds a hubUrl.
      // Omit publicKey — loadStoredCredentials derives it and cross-checks
      // when present. Supplying a mismatched pair would make inferHubUrl
      // silently skip the file.
      const existingCreds = {
        version: 1,
        hubUrl: "https://hub.example",
        agentId: "ag_existing",
        keyId: "k_e",
        privateKey: Buffer.alloc(32, 3).toString("base64"),
        savedAt: new Date().toISOString(),
      };
      const credDir = nodePath.join(tmp, ".botcord", "credentials");
      fs.mkdirSync(credDir, { recursive: true });
      fs.writeFileSync(
        nodePath.join(credDir, "ag_existing.json"),
        JSON.stringify(existingCreds),
      );
      mockState.cfg = {
        defaultRoute: { adapter: "claude-code", cwd: "/tmp" },
        routes: [],
        streamBlocks: true,
        agents: ["ag_existing"],
      };

      const registered = {
        agentId: "ag_slow",
        keyId: "k_slow",
        privateKey: Buffer.alloc(32, 21).toString("base64"),
        publicKey: Buffer.alloc(32, 22).toString("base64"),
        hubUrl: "https://hub.example",
        token: "tok",
        expiresAt: Date.now() + 60_000,
      };
      const register = vi.fn(async () => registered);

      const gw = makeFakeGateway();
      const provisioner = createProvisioner({
        gateway: gw as unknown as Parameters<typeof createProvisioner>[0]["gateway"],
        register: register as unknown as Parameters<typeof createProvisioner>[0]["register"],
      });
      const ack = await provisioner({
        id: "req_slow",
        type: CONTROL_FRAME_TYPES.PROVISION_AGENT,
        params: { name: "slow-agent" },
      });
      expect(ack.ok).toBe(true);
      const expectedCwd = nodePath.join(tmp, ".botcord", "agents", "ag_slow", "workspace");
      const credFile = nodePath.join(tmp, ".botcord", "credentials", "ag_slow.json");
      const saved = JSON.parse(fs.readFileSync(credFile, "utf8")) as Record<string, unknown>;
      expect(saved.cwd).toBe(expectedCwd);
      for (const f of SEED_FILES) {
        expect(fs.existsSync(nodePath.join(expectedCwd, f))).toBe(true);
      }
      const routes = gw.listManagedRoutes();
      expect(routes).toHaveLength(1);
      expect(routes[0].cwd).toBe(expectedCwd);
    });
  });

  it("honors an explicit params.cwd override while still seeding the workspace", async () => {
    await withSandboxHome(async ({ tmp, fs, path: nodePath }) => {
      const override = nodePath.join(tmp, "project-dir");
      fs.mkdirSync(override, { recursive: true });
      const gw = makeFakeGateway();
      const provisioner = createProvisioner({
        gateway: gw as unknown as Parameters<typeof createProvisioner>[0]["gateway"],
      });
      const privateKey = Buffer.alloc(32, 17).toString("base64");
      const ack = await provisioner({
        id: "req_override",
        type: CONTROL_FRAME_TYPES.PROVISION_AGENT,
        params: {
          cwd: override,
          credentials: {
            agentId: "ag_override",
            keyId: "k_o",
            privateKey,
            hubUrl: "https://hub.example",
          },
        },
      });
      expect(ack.ok).toBe(true);
      const credFile = nodePath.join(tmp, ".botcord", "credentials", "ag_override.json");
      const saved = JSON.parse(fs.readFileSync(credFile, "utf8")) as Record<string, unknown>;
      expect(saved.cwd).toBe(override);
      // Workspace still exists even when runtime cwd points elsewhere.
      const wsDir = nodePath.join(tmp, ".botcord", "agents", "ag_override", "workspace");
      for (const f of SEED_FILES) {
        expect(fs.existsSync(nodePath.join(wsDir, f))).toBe(true);
      }
      const routes = gw.listManagedRoutes();
      expect(routes[0].cwd).toBe(override);
    });
  });

  it("rejects params.credentials.cwd outside $HOME before any disk write", async () => {
    await withSandboxHome(async ({ tmp, fs, path: nodePath }) => {
      const gw = makeFakeGateway();
      const provisioner = createProvisioner({
        gateway: gw as unknown as Parameters<typeof createProvisioner>[0]["gateway"],
      });
      const privateKey = Buffer.alloc(32, 19).toString("base64");
      await expect(
        provisioner({
          id: "req_smuggle",
          type: CONTROL_FRAME_TYPES.PROVISION_AGENT,
          params: {
            credentials: {
              agentId: "ag_smuggle",
              keyId: "k_s",
              privateKey,
              hubUrl: "https://hub.example",
              cwd: "/etc",
            },
          },
        }),
      ).rejects.toThrow(/outside the user home/);
      // Credentials file must not have been written.
      const credFile = nodePath.join(tmp, ".botcord", "credentials", "ag_smuggle.json");
      expect(fs.existsSync(credFile)).toBe(false);
      expect(gw.addChannel).not.toHaveBeenCalled();
      expect(gw.listManagedRoutes()).toHaveLength(0);
    });
  });

  it("unlinks the credentials file when ensureAgentWorkspace fails", async () => {
    await withSandboxHome(async ({ tmp, fs, path: nodePath }) => {
      // Pre-create a FILE at the workspace dir path so mkdirSync(recursive)
      // throws ENOTDIR — forcing ensureAgentWorkspace to propagate.
      const agentDir = nodePath.join(tmp, ".botcord", "agents", "ag_blocked");
      fs.mkdirSync(agentDir, { recursive: true });
      fs.writeFileSync(nodePath.join(agentDir, "workspace"), "blocker");

      const gw = makeFakeGateway();
      const provisioner = createProvisioner({
        gateway: gw as unknown as Parameters<typeof createProvisioner>[0]["gateway"],
      });
      const privateKey = Buffer.alloc(32, 23).toString("base64");
      await expect(
        provisioner({
          id: "req_rollback",
          type: CONTROL_FRAME_TYPES.PROVISION_AGENT,
          params: {
            credentials: {
              agentId: "ag_blocked",
              keyId: "k_b",
              privateKey,
              hubUrl: "https://hub.example",
            },
          },
        }),
      ).rejects.toThrow();
      const credFile = nodePath.join(tmp, ".botcord", "credentials", "ag_blocked.json");
      expect(fs.existsSync(credFile)).toBe(false);
      expect(gw.addChannel).not.toHaveBeenCalled();
      expect(gw.listManagedRoutes()).toHaveLength(0);
    });
  });

  it("rolls back the managed route when addChannel fails", async () => {
    await withSandboxHome(async ({ tmp, fs, path: nodePath }) => {
      const gw = makeFakeGateway();
      gw.addChannel.mockImplementationOnce(async () => {
        throw new Error("channel boom");
      });
      const provisioner = createProvisioner({
        gateway: gw as unknown as Parameters<typeof createProvisioner>[0]["gateway"],
      });
      const privateKey = Buffer.alloc(32, 29).toString("base64");
      await expect(
        provisioner({
          id: "req_ch_fail",
          type: CONTROL_FRAME_TYPES.PROVISION_AGENT,
          params: {
            credentials: {
              agentId: "ag_chfail",
              keyId: "k_c",
              privateKey,
              hubUrl: "https://hub.example",
            },
          },
        }),
      ).rejects.toThrow(/channel boom/);
      // Credentials unlinked; managed route never added (addChannel threw
      // before the upsert step).
      const credFile = nodePath.join(tmp, ".botcord", "credentials", "ag_chfail.json");
      expect(fs.existsSync(credFile)).toBe(false);
      expect(gw.listManagedRoutes()).toHaveLength(0);
    });
  });
});

describe("adoptDiscoveredOpenclawAgents", () => {
  it("registers unbound OpenClaw agents and writes the routing binding", async () => {
    await withSandboxHome(async ({ tmp, fs, path: nodePath }) => {
      const credDir = nodePath.join(tmp, ".botcord", "credentials");
      fs.mkdirSync(credDir, { recursive: true });
      fs.writeFileSync(
        nodePath.join(credDir, "ag_seed.json"),
        JSON.stringify({
          version: 1,
          hubUrl: "https://hub.example",
          agentId: "ag_seed",
          keyId: "k_seed",
          privateKey: Buffer.alloc(32, 5).toString("base64"),
          savedAt: new Date().toISOString(),
        }),
      );
      mockState.cfg = {
        defaultRoute: { adapter: "claude-code", cwd: "/tmp" },
        routes: [],
        streamBlocks: true,
        agents: ["ag_seed"],
        openclawGateways: [{ name: "local", url: "ws://127.0.0.1:18789" }],
      };

      const gw = makeFakeGateway(["ag_seed"]);
      const register = vi.fn(async () => ({
        agentId: "ag_adopted",
        keyId: "k_adopted",
        privateKey: Buffer.alloc(32, 31).toString("base64"),
        publicKey: Buffer.alloc(32, 32).toString("base64"),
        hubUrl: "https://hub.example",
        token: "tok",
        expiresAt: Date.now() + 60_000,
      }));

      const res = await adoptDiscoveredOpenclawAgents({
        gateway: gw as unknown as Parameters<typeof adoptDiscoveredOpenclawAgents>[0]["gateway"],
        register: register as unknown as Parameters<typeof adoptDiscoveredOpenclawAgents>[0]["register"],
        cfg: mockState.cfg as unknown as DaemonConfig,
        probe: async () => ({ ok: true, agents: [{ id: "main", name: "Main Agent" }] }),
      });

      expect(res.adopted).toEqual(["ag_adopted"]);
      expect(register).toHaveBeenCalledWith(
        "https://hub.example",
        "Main Agent",
        "OpenClaw agent main adopted from gateway local.",
      );
      const saved = JSON.parse(
        fs.readFileSync(nodePath.join(credDir, "ag_adopted.json"), "utf8"),
      ) as Record<string, unknown>;
      expect(saved.runtime).toBe("openclaw-acp");
      expect(saved.openclawGateway).toBe("local");
      expect(saved.openclawAgent).toBe("main");
      expect((mockState.cfg.agents as string[])).toContain("ag_adopted");
      expect(gw.addChannel).toHaveBeenCalledWith(
        expect.objectContaining({ id: "ag_adopted", type: "botcord" }),
      );
      const route = gw.listManagedRoutes().find((r) => r.match?.accountId === "ag_adopted");
      expect(route?.runtime).toBe("openclaw-acp");
      expect(route?.gateway?.name).toBe("local");
      expect(route?.gateway?.openclawAgent).toBe("main");
    });
  });

  it("skips an OpenClaw agent that is already bound in credentials", async () => {
    await withSandboxHome(async ({ tmp, fs, path: nodePath }) => {
      const credDir = nodePath.join(tmp, ".botcord", "credentials");
      fs.mkdirSync(credDir, { recursive: true });
      fs.writeFileSync(
        nodePath.join(credDir, "ag_existing.json"),
        JSON.stringify({
          version: 1,
          hubUrl: "https://hub.example",
          agentId: "ag_existing",
          keyId: "k_existing",
          privateKey: Buffer.alloc(32, 6).toString("base64"),
          savedAt: new Date().toISOString(),
          runtime: "openclaw-acp",
          openclawGateway: "local",
          openclawAgent: "main",
        }),
      );
      mockState.cfg = {
        defaultRoute: { adapter: "claude-code", cwd: "/tmp" },
        routes: [],
        streamBlocks: true,
        agents: ["ag_existing"],
        openclawGateways: [{ name: "local", url: "ws://127.0.0.1:18789" }],
      };
      const register = vi.fn();

      const res = await adoptDiscoveredOpenclawAgents({
        gateway: makeFakeGateway(["ag_existing"]) as unknown as Parameters<typeof adoptDiscoveredOpenclawAgents>[0]["gateway"],
        register: register as unknown as Parameters<typeof adoptDiscoveredOpenclawAgents>[0]["register"],
        cfg: mockState.cfg as unknown as DaemonConfig,
        probe: async () => ({ ok: true, agents: [{ id: "main" }] }),
      });

      expect(res.adopted).toEqual([]);
      expect(res.skipped).toEqual([
        { gateway: "local", openclawAgent: "main", reason: "already_bound" },
      ]);
      expect(register).not.toHaveBeenCalled();
    });
  });

  it("skips auto-adopt when local OpenClaw ACP is explicitly disabled", async () => {
    await withSandboxHome(async ({ tmp, fs, path: nodePath }) => {
      const credDir = nodePath.join(tmp, ".botcord", "credentials");
      fs.mkdirSync(credDir, { recursive: true });
      fs.writeFileSync(
        nodePath.join(credDir, "ag_seed.json"),
        JSON.stringify({
          version: 1,
          hubUrl: "https://hub.example",
          agentId: "ag_seed",
          keyId: "k_seed",
          privateKey: Buffer.alloc(32, 8).toString("base64"),
          savedAt: new Date().toISOString(),
        }),
      );
      const openclawDir = nodePath.join(tmp, ".openclaw");
      fs.mkdirSync(openclawDir, { recursive: true });
      fs.writeFileSync(
        nodePath.join(openclawDir, "openclaw.json"),
        JSON.stringify({ acp: { enabled: false } }),
      );
      mockState.cfg = {
        defaultRoute: { adapter: "claude-code", cwd: "/tmp" },
        routes: [],
        streamBlocks: true,
        agents: ["ag_seed"],
        openclawGateways: [{ name: "local", url: "ws://127.0.0.1:18789" }],
      };
      const register = vi.fn();
      const probe = vi.fn<Parameters<typeof adoptDiscoveredOpenclawAgents>[0]["probe"]>(
        async () => ({ ok: true, agents: [{ id: "main" }] }),
      );

      const res = await adoptDiscoveredOpenclawAgents({
        gateway: makeFakeGateway(["ag_seed"]) as unknown as Parameters<typeof adoptDiscoveredOpenclawAgents>[0]["gateway"],
        register: register as unknown as Parameters<typeof adoptDiscoveredOpenclawAgents>[0]["register"],
        cfg: mockState.cfg as unknown as DaemonConfig,
        probe,
      });

      expect(res).toEqual({
        adopted: [],
        skipped: [{ gateway: "local", reason: "acp_disabled" }],
        failed: [],
      });
      expect(probe).not.toHaveBeenCalled();
      expect(register).not.toHaveBeenCalled();
    });
  });

  it("uses the OpenClaw workspace identity name when agents.list has no name", async () => {
    await withSandboxHome(async ({ tmp, fs, path: nodePath }) => {
      const credDir = nodePath.join(tmp, ".botcord", "credentials");
      fs.mkdirSync(credDir, { recursive: true });
      fs.writeFileSync(
        nodePath.join(credDir, "ag_seed.json"),
        JSON.stringify({
          version: 1,
          hubUrl: "https://hub.example",
          agentId: "ag_seed",
          keyId: "k_seed",
          privateKey: Buffer.alloc(32, 7).toString("base64"),
          savedAt: new Date().toISOString(),
        }),
      );
      const ocWorkspace = nodePath.join(tmp, ".openclaw", "workspace-swe");
      fs.mkdirSync(ocWorkspace, { recursive: true });
      fs.writeFileSync(
        nodePath.join(ocWorkspace, "IDENTITY.md"),
        ["# IDENTITY.md", "", "- **Name:** Danny", "- **Vibe:** ships fast"].join("\n"),
      );
      fs.writeFileSync(
        nodePath.join(tmp, ".openclaw", "openclaw.json"),
        JSON.stringify({
          agents: {
            defaults: { workspace: nodePath.join(tmp, ".openclaw", "workspace") },
            list: [{ id: "swe", workspace: ocWorkspace }],
          },
        }),
      );
      mockState.cfg = {
        defaultRoute: { adapter: "claude-code", cwd: "/tmp" },
        routes: [],
        streamBlocks: true,
        agents: ["ag_seed"],
        openclawGateways: [{ name: "local", url: "ws://127.0.0.1:18789" }],
      };

      const register = vi.fn(async () => ({
        agentId: "ag_swe",
        keyId: "k_swe",
        privateKey: Buffer.alloc(32, 33).toString("base64"),
        publicKey: Buffer.alloc(32, 34).toString("base64"),
        hubUrl: "https://hub.example",
        token: "tok",
        expiresAt: Date.now() + 60_000,
      }));

      await adoptDiscoveredOpenclawAgents({
        gateway: makeFakeGateway(["ag_seed"]) as unknown as Parameters<typeof adoptDiscoveredOpenclawAgents>[0]["gateway"],
        register: register as unknown as Parameters<typeof adoptDiscoveredOpenclawAgents>[0]["register"],
        cfg: mockState.cfg as unknown as DaemonConfig,
        probe: async () => ({ ok: true, agents: [{ id: "swe" }] }),
      });

      expect(register).toHaveBeenCalledWith(
        "https://hub.example",
        "Danny",
        "OpenClaw agent swe adopted from gateway local.",
      );
    });
  });
});

// ---------------------------------------------------------------------------
// revoke_agent — new flag semantics (plan §11.3)
// ---------------------------------------------------------------------------

function seedAgentOnDisk(
  fs: typeof import("node:fs"),
  nodePath: typeof import("node:path"),
  tmp: string,
  agentId: string,
): { credFile: string; workspaceDir: string; stateDir: string; homeDir: string } {
  const credDir = nodePath.join(tmp, ".botcord", "credentials");
  const homeDir = nodePath.join(tmp, ".botcord", "agents", agentId);
  const workspaceDir = nodePath.join(homeDir, "workspace");
  const stateDir = nodePath.join(homeDir, "state");
  fs.mkdirSync(credDir, { recursive: true });
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  const credFile = nodePath.join(credDir, `${agentId}.json`);
  fs.writeFileSync(
    credFile,
    JSON.stringify({
      version: 1,
      hubUrl: "https://hub.example",
      agentId,
      keyId: `k_${agentId}`,
      privateKey: Buffer.alloc(32, 41).toString("base64"),
      publicKey: Buffer.alloc(32, 42).toString("base64"),
      savedAt: new Date().toISOString(),
    }),
  );
  fs.writeFileSync(nodePath.join(workspaceDir, "memory.md"), "# Memory\nprecious\n");
  fs.writeFileSync(nodePath.join(stateDir, "working-memory.json"), "{}");
  return { credFile, workspaceDir, stateDir, homeDir };
}

describe("revoke_agent respects deleteState / deleteWorkspace flags", () => {
  it("default flags: credentials deleted, state deleted, workspace preserved", async () => {
    await withSandboxHome(async ({ tmp, fs, path: nodePath }) => {
      const { credFile, workspaceDir, stateDir } = seedAgentOnDisk(
        fs,
        nodePath,
        tmp,
        "ag_default",
      );
      const gw = makeFakeGateway(["ag_default"]);
      const provisioner = createProvisioner({
        gateway: gw as unknown as Parameters<typeof createProvisioner>[0]["gateway"],
      });
      const ack = await provisioner({
        id: "req_rev_default",
        type: CONTROL_FRAME_TYPES.REVOKE_AGENT,
        params: { agentId: "ag_default" },
      });
      expect(ack.ok).toBe(true);
      const result = ack.result as {
        agentId: string;
        credentialsDeleted: boolean;
        stateDeleted: boolean;
        workspaceDeleted: boolean;
      };
      expect(result.credentialsDeleted).toBe(true);
      expect(result.stateDeleted).toBe(true);
      expect(result.workspaceDeleted).toBe(false);
      expect(fs.existsSync(credFile)).toBe(false);
      expect(fs.existsSync(stateDir)).toBe(false);
      expect(fs.existsSync(workspaceDir)).toBe(true);
      expect(gw.removeManagedRoute).toHaveBeenCalledWith("ag_default");
    });
  });

  it("deleteCredentials:false keeps everything on disk but still revokes the channel + managed route", async () => {
    await withSandboxHome(async ({ tmp, fs, path: nodePath }) => {
      const { credFile, workspaceDir, stateDir } = seedAgentOnDisk(
        fs,
        nodePath,
        tmp,
        "ag_keep",
      );
      const gw = makeFakeGateway(["ag_keep"]);
      const provisioner = createProvisioner({
        gateway: gw as unknown as Parameters<typeof createProvisioner>[0]["gateway"],
      });
      const ack = await provisioner({
        id: "req_rev_keep",
        type: CONTROL_FRAME_TYPES.REVOKE_AGENT,
        params: { agentId: "ag_keep", deleteCredentials: false },
      });
      expect(ack.ok).toBe(true);
      const result = ack.result as {
        credentialsDeleted: boolean;
        stateDeleted: boolean;
        workspaceDeleted: boolean;
      };
      expect(result.credentialsDeleted).toBe(false);
      expect(result.stateDeleted).toBe(false);
      expect(result.workspaceDeleted).toBe(false);
      expect(fs.existsSync(credFile)).toBe(true);
      expect(fs.existsSync(stateDir)).toBe(true);
      expect(fs.existsSync(workspaceDir)).toBe(true);
      // Channel + managed route cleanup still runs unconditionally.
      expect(gw.removeChannel).toHaveBeenCalledWith("ag_keep", "revoked by hub");
      expect(gw.removeManagedRoute).toHaveBeenCalledWith("ag_keep");
    });
  });

  it("deleteWorkspace:true removes the entire agent home (subsumes state)", async () => {
    await withSandboxHome(async ({ tmp, fs, path: nodePath }) => {
      const { credFile, homeDir } = seedAgentOnDisk(fs, nodePath, tmp, "ag_wipe");
      const gw = makeFakeGateway(["ag_wipe"]);
      const provisioner = createProvisioner({
        gateway: gw as unknown as Parameters<typeof createProvisioner>[0]["gateway"],
      });
      const ack = await provisioner({
        id: "req_rev_wipe",
        type: CONTROL_FRAME_TYPES.REVOKE_AGENT,
        params: { agentId: "ag_wipe", deleteWorkspace: true },
      });
      expect(ack.ok).toBe(true);
      const result = ack.result as {
        credentialsDeleted: boolean;
        stateDeleted: boolean;
        workspaceDeleted: boolean;
      };
      expect(result.credentialsDeleted).toBe(true);
      expect(result.stateDeleted).toBe(true);
      expect(result.workspaceDeleted).toBe(true);
      expect(fs.existsSync(credFile)).toBe(false);
      expect(fs.existsSync(homeDir)).toBe(false);
    });
  });

  it("deleteState:false with deleteCredentials:true keeps state + workspace", async () => {
    await withSandboxHome(async ({ tmp, fs, path: nodePath }) => {
      const { credFile, workspaceDir, stateDir } = seedAgentOnDisk(
        fs,
        nodePath,
        tmp,
        "ag_keepstate",
      );
      const gw = makeFakeGateway(["ag_keepstate"]);
      const provisioner = createProvisioner({
        gateway: gw as unknown as Parameters<typeof createProvisioner>[0]["gateway"],
      });
      const ack = await provisioner({
        id: "req_rev_keepstate",
        type: CONTROL_FRAME_TYPES.REVOKE_AGENT,
        params: { agentId: "ag_keepstate", deleteCredentials: true, deleteState: false },
      });
      expect(ack.ok).toBe(true);
      const result = ack.result as {
        credentialsDeleted: boolean;
        stateDeleted: boolean;
        workspaceDeleted: boolean;
      };
      expect(result.credentialsDeleted).toBe(true);
      expect(result.stateDeleted).toBe(false);
      expect(result.workspaceDeleted).toBe(false);
      expect(fs.existsSync(credFile)).toBe(false);
      expect(fs.existsSync(stateDir)).toBe(true);
      expect(fs.existsSync(workspaceDir)).toBe(true);
    });
  });

  it("preserves an operator-authored cfg.routes[] entry with the same accountId", async () => {
    await withSandboxHome(async ({ tmp, fs, path: nodePath }) => {
      seedAgentOnDisk(fs, nodePath, tmp, "ag_opkept");
      mockState.cfg = {
        defaultRoute: { adapter: "claude-code", cwd: tmp },
        routes: [
          {
            match: { accountId: "ag_opkept" },
            adapter: "claude-code",
            cwd: tmp,
          },
        ],
        streamBlocks: true,
        agents: ["ag_opkept"],
      };
      const gw = makeFakeGateway(["ag_opkept"]);
      const provisioner = createProvisioner({
        gateway: gw as unknown as Parameters<typeof createProvisioner>[0]["gateway"],
      });
      await provisioner({
        id: "req_rev_op",
        type: CONTROL_FRAME_TYPES.REVOKE_AGENT,
        params: { agentId: "ag_opkept" },
      });
      const saved = mockState.saved[mockState.saved.length - 1] as unknown as DaemonConfig;
      expect(saved.routes).toHaveLength(1);
      expect(saved.routes[0].match.accountId).toBe("ag_opkept");
    });
  });
});

// ---------------------------------------------------------------------------
// hello + update_agent identity sync (lightweight reconcile path)
// ---------------------------------------------------------------------------

describe("hello identity snapshot", () => {
  it("rewrites identity.md for every agent in the snapshot", async () => {
    await withSandboxHome(async ({ tmp, fs, path: nodePath }) => {
      const { ensureAgentWorkspace } = await import("../agent-workspace.js");
      ensureAgentWorkspace("ag_h1", { displayName: "Old1", bio: "Old bio 1" });
      ensureAgentWorkspace("ag_h2", { displayName: "Old2", bio: "Old bio 2" });
      void tmp;

      const gw = makeFakeGateway();
      const provisioner = createProvisioner({
        gateway: gw as unknown as Parameters<typeof createProvisioner>[0]["gateway"],
      });

      const ack = await provisioner({
        id: "req_hello",
        type: CONTROL_FRAME_TYPES.HELLO,
        params: {
          server_time: Date.now(),
          agents: [
            { agentId: "ag_h1", displayName: "Fresh1", bio: "Fresh bio 1" },
            { agentId: "ag_h2", displayName: "Fresh2", bio: null },
            { agentId: "ag_missing", displayName: "Nope", bio: "Nope" },
          ],
        },
      });
      expect(ack.ok).toBe(true);
      const result = ack.result as { updated: number; skipped: number };
      expect(result.updated).toBe(2);
      expect(result.skipped).toBe(1);

      const id1 = fs.readFileSync(
        nodePath.join(tmp, ".botcord", "agents", "ag_h1", "workspace", "identity.md"),
        "utf8",
      );
      expect(id1).toContain("Fresh1");
      expect(id1).toContain("Fresh bio 1");
      expect(id1).not.toContain("Old1");

      const id2 = fs.readFileSync(
        nodePath.join(tmp, ".botcord", "agents", "ag_h2", "workspace", "identity.md"),
        "utf8",
      );
      expect(id2).toContain("Fresh2");
      // bio cleared → placeholder
      expect(id2).toContain("_(none provided at provision time");
    });
  });

  it("tolerates a hello frame with no agents array", async () => {
    const gw = makeFakeGateway();
    const provisioner = createProvisioner({
      gateway: gw as unknown as Parameters<typeof createProvisioner>[0]["gateway"],
    });
    const ack = await provisioner({
      id: "req_hello_empty",
      type: CONTROL_FRAME_TYPES.HELLO,
      params: { server_time: Date.now() },
    });
    expect(ack.ok).toBe(true);
  });
});

describe("update_agent handler", () => {
  it("rewrites identity.md for the targeted agent", async () => {
    await withSandboxHome(async ({ tmp, fs, path: nodePath }) => {
      const { ensureAgentWorkspace } = await import("../agent-workspace.js");
      ensureAgentWorkspace("ag_u1", { displayName: "Before", bio: "Before bio" });

      const gw = makeFakeGateway();
      const provisioner = createProvisioner({
        gateway: gw as unknown as Parameters<typeof createProvisioner>[0]["gateway"],
      });
      const ack = await provisioner({
        id: "req_update",
        type: CONTROL_FRAME_TYPES.UPDATE_AGENT,
        params: { agentId: "ag_u1", displayName: "After", bio: "After bio" },
      });
      expect(ack.ok).toBe(true);
      expect((ack.result as { changed: boolean }).changed).toBe(true);

      const md = fs.readFileSync(
        nodePath.join(tmp, ".botcord", "agents", "ag_u1", "workspace", "identity.md"),
        "utf8",
      );
      expect(md).toContain("After");
      expect(md).toContain("After bio");
    });
  });

  it("rejects update_agent without agentId", async () => {
    const gw = makeFakeGateway();
    const provisioner = createProvisioner({
      gateway: gw as unknown as Parameters<typeof createProvisioner>[0]["gateway"],
    });
    const ack = await provisioner({
      id: "req_update_bad",
      type: CONTROL_FRAME_TYPES.UPDATE_AGENT,
      params: {},
    });
    expect(ack.ok).toBe(false);
    expect(ack.error?.code).toBe("bad_params");
  });
});
