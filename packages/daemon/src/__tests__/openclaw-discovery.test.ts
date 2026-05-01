import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  defaultOpenclawDiscoveryPorts,
  defaultOpenclawDiscoverySystemdUnitPaths,
  defaultOpenclawDiscoveryTokenFilePaths,
  discoverLocalOpenclawGateways,
  mergeOpenclawGateways,
  openclawAutoProvisionEnabled,
  openclawDiscoveryConfigEnabled,
} from "../openclaw-discovery.js";
import type { DaemonConfig } from "../config.js";
import type { WsEndpointProbeFn } from "../provision.js";

let tmp: string | null = null;

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = null;
});

function tempDir(): string {
  tmp = mkdtempSync(path.join(tmpdir(), "openclaw-discovery-"));
  return tmp;
}

function baseConfig(): DaemonConfig {
  return {
    defaultRoute: { adapter: "claude-code", cwd: "/tmp" },
    routes: [],
    streamBlocks: true,
  };
}

describe("openclaw discovery config flags", () => {
  it("keeps gateway discovery enabled by default", () => {
    expect(openclawDiscoveryConfigEnabled(baseConfig())).toBe(true);
    expect(
      openclawDiscoveryConfigEnabled({
        ...baseConfig(),
        openclawDiscovery: { enabled: false },
      }),
    ).toBe(false);
  });

  it("requires explicit opt-in for OpenClaw auto-provision", () => {
    expect(openclawAutoProvisionEnabled(baseConfig())).toBe(false);
    expect(
      openclawAutoProvisionEnabled({
        ...baseConfig(),
        openclawDiscovery: {},
      }),
    ).toBe(false);
    expect(
      openclawAutoProvisionEnabled({
        ...baseConfig(),
        openclawDiscovery: { autoProvision: true },
      }),
    ).toBe(true);
    expect(
      openclawAutoProvisionEnabled({
        ...baseConfig(),
        openclawDiscovery: { autoProvision: false },
      }),
    ).toBe(false);
  });
});

describe("discoverLocalOpenclawGateways", () => {
  it("discovers JSON and TOML acp config files", async () => {
    const dir = tempDir();
    writeFileSync(
      path.join(dir, "one.json"),
      JSON.stringify({ acp: { url: "ws://127.0.0.1:18789/acp", tokenFile: "/tmp/token" } }),
    );
    writeFileSync(
      path.join(dir, "two.toml"),
      ['[acp]', 'url = "ws://127.0.0.1:18790/acp"', 'token = "secret"'].join("\n"),
    );

    const found = await discoverLocalOpenclawGateways({
      searchPaths: [dir],
      defaultPorts: [],
    });

    expect(found).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          url: "ws://127.0.0.1:18789/acp",
          tokenFile: "/tmp/token",
          source: "config-file",
        }),
        expect.objectContaining({
          url: "ws://127.0.0.1:18790/acp",
          token: "secret",
          source: "config-file",
        }),
      ]),
    );
  });

  it("parses OpenClaw's native gateway.port + auth.token shape", async () => {
    const dir = tempDir();
    writeFileSync(
      path.join(dir, "openclaw.json"),
      JSON.stringify({
        gateway: {
          port: 18789,
          bind: "loopback",
          auth: { mode: "token", token: "native-token" },
        },
      }),
    );

    const found = await discoverLocalOpenclawGateways({
      searchPaths: [dir],
      defaultPorts: [],
    });

    expect(found).toEqual([
      expect.objectContaining({
        url: "ws://127.0.0.1:18789",
        token: "native-token",
        source: "config-file",
      }),
    ]);
  });

  it("uses OPENCLAW_ACP_URL and token env vars", async () => {
    const found = await discoverLocalOpenclawGateways({
      searchPaths: [],
      defaultPorts: [],
      env: {
        OPENCLAW_ACP_URL: "ws://127.0.0.1:18888/acp",
        OPENCLAW_ACP_TOKEN: "env-token",
      },
    });

    expect(found).toEqual([
      expect.objectContaining({
        url: "ws://127.0.0.1:18888/acp",
        token: "env-token",
        source: "env",
      }),
    ]);
  });

  it("uses OPENCLAW_GATEWAY_URL and gateway token env vars", async () => {
    const found = await discoverLocalOpenclawGateways({
      searchPaths: [],
      defaultPorts: [],
      env: {
        OPENCLAW_GATEWAY_URL: "ws://127.0.0.1:16200",
        OPENCLAW_GATEWAY_TOKEN: "gateway-token",
      },
    });

    expect(found).toEqual([
      expect.objectContaining({
        url: "ws://127.0.0.1:16200",
        token: "gateway-token",
        source: "env",
      }),
    ]);
  });

  it("builds gateway URL from OPENCLAW_GATEWAY_PORT", async () => {
    const found = await discoverLocalOpenclawGateways({
      searchPaths: [],
      defaultPorts: [],
      env: {
        OPENCLAW_GATEWAY_PORT: "16200",
        OPENCLAW_GATEWAY_TOKEN: "gateway-token",
      },
    });

    expect(found).toEqual([
      expect.objectContaining({
        url: "ws://127.0.0.1:16200",
        token: "gateway-token",
        source: "env",
      }),
    ]);
  });

  it("discovers gateway port and token from a systemd OpenClaw unit", async () => {
    const dir = tempDir();
    const unit = path.join(dir, "openclaw.service");
    writeFileSync(
      unit,
      [
        "[Service]",
        "User=openclaw",
        'Environment="OPENCLAW_GATEWAY_TOKEN=systemd-token"',
        "ExecStart=/usr/bin/openclaw gateway --bind lan --port 16200 --allow-unconfigured",
      ].join("\n"),
    );

    const found = await discoverLocalOpenclawGateways({
      searchPaths: [],
      defaultPorts: [],
      systemdUnitPaths: [unit],
      env: {},
    });

    expect(defaultOpenclawDiscoverySystemdUnitPaths()).toEqual(
      expect.arrayContaining(["/etc/systemd/system/openclaw.service"]),
    );
    expect(found).toEqual([
      expect.objectContaining({
        url: "ws://127.0.0.1:16200",
        token: "systemd-token",
        source: "systemd-unit",
      }),
    ]);
  });

  it("discovers gateway token from a systemd EnvironmentFile", async () => {
    const dir = tempDir();
    const unit = path.join(dir, "openclaw.service");
    const envFile = path.join(dir, "openclaw.env");
    writeFileSync(envFile, 'OPENCLAW_GATEWAY_TOKEN="file-token"\n');
    writeFileSync(
      unit,
      [
        "[Service]",
        `EnvironmentFile=${envFile}`,
        "Environment=OPENCLAW_GATEWAY_PORT=16200",
        "ExecStart=/usr/bin/openclaw gateway --bind lan --allow-unconfigured",
      ].join("\n"),
    );

    const found = await discoverLocalOpenclawGateways({
      searchPaths: [],
      defaultPorts: [],
      systemdUnitPaths: [unit],
      env: {},
    });

    expect(found).toEqual([
      expect.objectContaining({
        url: "ws://127.0.0.1:16200",
        token: "file-token",
        source: "systemd-unit",
      }),
    ]);
  });

  it("prefers OPENCLAW_ACP env vars over OPENCLAW_GATEWAY env vars", async () => {
    const found = await discoverLocalOpenclawGateways({
      searchPaths: [],
      defaultPorts: [],
      env: {
        OPENCLAW_ACP_URL: "ws://127.0.0.1:18888",
        OPENCLAW_ACP_TOKEN: "acp-token",
        OPENCLAW_GATEWAY_URL: "ws://127.0.0.1:16200",
        OPENCLAW_GATEWAY_TOKEN: "gateway-token",
      },
    });

    expect(found).toEqual([
      expect.objectContaining({
        url: "ws://127.0.0.1:18888",
        token: "acp-token",
        source: "env",
      }),
    ]);
  });

  it("includes 16200 in default discovery ports", () => {
    expect(defaultOpenclawDiscoveryPorts()).toEqual(expect.arrayContaining([18789, 16200]));
  });

  it("adds default-port candidates only when the probe succeeds", async () => {
    const probe = vi.fn<WsEndpointProbeFn>(async ({ url }) => ({
      ok: url.includes("18789"),
      agents: [],
    }));

    const found = await discoverLocalOpenclawGateways({
      searchPaths: [],
      defaultPorts: [18789, 18790],
      probe,
      timeoutMs: 10,
    });

    expect(probe).toHaveBeenCalledTimes(2);
    expect(found.map((g) => g.url)).toEqual(["ws://127.0.0.1:18789"]);
  });

  it("attaches gateway token fallback to default-port discovery", async () => {
    const probe = vi.fn<WsEndpointProbeFn>(async () => ({
      ok: true,
      agents: [],
    }));

    const found = await discoverLocalOpenclawGateways({
      searchPaths: [],
      defaultPorts: [16200],
      probe,
      timeoutMs: 10,
      env: {
        OPENCLAW_GATEWAY_TOKEN: "gateway-token",
      },
    });

    expect(probe).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "ws://127.0.0.1:16200",
        token: "gateway-token",
      }),
    );
    expect(found).toEqual([
      expect.objectContaining({
        url: "ws://127.0.0.1:16200",
        token: "gateway-token",
        source: "default-port",
      }),
    ]);
  });

  it("attaches conventional tokenFile fallback to default-port discovery", async () => {
    const home = tempDir();
    const prevHome = process.env.HOME;
    process.env.HOME = home;
    mkdirSync(path.join(home, ".openclaw"), { recursive: true });
    const tokenFile = path.join(home, ".openclaw", "gateway-token");
    writeFileSync(tokenFile, "gateway-token\n");
    const probe = vi.fn<WsEndpointProbeFn>(async () => ({
      ok: true,
      agents: [],
    }));

    try {
      const found = await discoverLocalOpenclawGateways({
        searchPaths: [],
        defaultPorts: [16200],
        probe,
        timeoutMs: 10,
        env: {},
      });

      expect(defaultOpenclawDiscoveryTokenFilePaths()).toEqual(
        expect.arrayContaining(["~/.openclaw/gateway-token"]),
      );
      expect(probe).toHaveBeenCalledWith(
        expect.objectContaining({
          url: "ws://127.0.0.1:16200",
          token: "gateway-token",
        }),
      );
      expect(found).toEqual([
        expect.objectContaining({
          url: "ws://127.0.0.1:16200",
          tokenFile: "~/.openclaw/gateway-token",
          source: "default-port",
        }),
      ]);
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
    }
  });

  it("prefers config-file auth details over lower-priority duplicate sources", async () => {
    const dir = tempDir();
    writeFileSync(
      path.join(dir, "one.json"),
      JSON.stringify({ acp: { url: "ws://127.0.0.1:18789", token: "file-token" } }),
    );
    const probe = vi.fn<WsEndpointProbeFn>(async () => ({ ok: true }));

    const found = await discoverLocalOpenclawGateways({
      searchPaths: [dir],
      defaultPorts: [18789],
      probe,
      env: {
        OPENCLAW_ACP_URL: "ws://127.0.0.1:18789",
        OPENCLAW_ACP_TOKEN: "env-token",
      },
    });

    expect(found).toHaveLength(1);
    expect(found[0]).toEqual(
      expect.objectContaining({ source: "config-file", token: "file-token" }),
    );
  });
});

describe("mergeOpenclawGateways", () => {
  it("backfills token onto an existing profile that lacks one", () => {
    const cfg = baseConfig();
    cfg.openclawGateways = [
      { name: "openclaw-127-0-0-1-18789", url: "ws://127.0.0.1:18789" },
    ];
    const merged = mergeOpenclawGateways(cfg, [
      {
        name: "openclaw-127-0-0-1-18789",
        url: "ws://127.0.0.1:18789",
        token: "discovered",
        source: "config-file",
      },
    ]);

    expect(merged.changed).toBe(true);
    expect(merged.added).toEqual([]);
    expect(merged.cfg.openclawGateways).toEqual([
      { name: "openclaw-127-0-0-1-18789", url: "ws://127.0.0.1:18789", token: "discovered" },
    ]);
  });

  it("appends new URLs and keeps existing profiles untouched", () => {
    const cfg = baseConfig();
    cfg.openclawGateways = [{ name: "local", url: "ws://127.0.0.1:18789/acp", token: "user-token" }];
    const merged = mergeOpenclawGateways(cfg, [
      {
        name: "openclaw-127-0-0-1-18789",
        url: "ws://127.0.0.1:18789/acp",
        token: "discovered-token",
        source: "env",
      },
      {
        name: "openclaw-127-0-0-1-18790",
        url: "ws://127.0.0.1:18790/acp",
        source: "default-port",
      },
    ]);

    expect(merged.changed).toBe(true);
    expect(merged.cfg.openclawGateways).toEqual([
      { name: "local", url: "ws://127.0.0.1:18789/acp", token: "user-token" },
      { name: "openclaw-127-0-0-1-18790", url: "ws://127.0.0.1:18790/acp" },
    ]);
  });
});
