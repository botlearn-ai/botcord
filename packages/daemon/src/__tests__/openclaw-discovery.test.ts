import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  discoverLocalOpenclawGateways,
  mergeOpenclawGateways,
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
