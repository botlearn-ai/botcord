import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Hoisted mock for `../adapters/runtimes.js` so each suite can stub
// `detectRuntimes()` independently — we want coverage of the "empty
// gateway probe" and "single runtime" cases without touching the real
// filesystem/$PATH.
const mockState = {
  entries: [] as Array<{
    id: string;
    displayName: string;
    binary: string;
    supportsRun: boolean;
    result: { available: boolean; path?: string; version?: string };
  }>,
};

vi.mock("../adapters/runtimes.js", async () => {
  const actual = await vi.importActual<typeof import("../adapters/runtimes.js")>(
    "../adapters/runtimes.js",
  );
  return {
    ...actual,
    detectRuntimes: () => mockState.entries.slice(),
  };
});

const {
  collectRuntimeSnapshot,
  collectRuntimeSnapshotAsync,
  clearRuntimeProbeCache,
  createProvisioner,
} = await import("../provision.js");

beforeEach(() => {
  // The L1 probe is memoized for 30s in production; tests rotate the
  // mocked runtime list between cases, so reset before each.
  clearRuntimeProbeCache();
});
const { pushRuntimeSnapshot } = await import("../daemon.js");
const { CONTROL_FRAME_TYPES } = await import("@botcord/protocol-core");
import type { GatewayChannelConfig, GatewayRuntimeSnapshot } from "../gateway/index.js";

function setRuntimes(entries: typeof mockState.entries): void {
  mockState.entries = entries;
}

describe("collectRuntimeSnapshot", () => {
  it("returns an empty runtimes array when no adapters are registered", () => {
    setRuntimes([]);
    const snap = collectRuntimeSnapshot();
    expect(Array.isArray(snap.runtimes)).toBe(true);
    expect(snap.runtimes).toHaveLength(0);
    expect(typeof snap.probedAt).toBe("number");
    expect(snap.probedAt).toBeGreaterThan(0);
  });

  it("maps gateway probe entries to wire-level RuntimeProbeResult shape", () => {
    setRuntimes([
      {
        id: "claude-code",
        displayName: "Claude Code",
        binary: "claude",
        supportsRun: true,
        result: { available: true, version: "1.2.3", path: "/usr/local/bin/claude" },
      },
      {
        id: "codex",
        displayName: "Codex",
        binary: "codex",
        supportsRun: true,
        result: { available: false },
      },
    ]);
    const snap = collectRuntimeSnapshot();
    expect(snap.runtimes).toEqual([
      {
        id: "claude-code",
        available: true,
        version: "1.2.3",
        path: "/usr/local/bin/claude",
      },
      { id: "codex", available: false },
    ]);
  });

  it("omits optional fields rather than emitting explicit undefineds", () => {
    setRuntimes([
      {
        id: "gemini",
        displayName: "Gemini",
        binary: "gemini",
        supportsRun: true,
        result: { available: true },
      },
    ]);
    const [entry] = collectRuntimeSnapshot().runtimes;
    expect(entry).toBeDefined();
    expect(Object.keys(entry!).sort()).toEqual(["available", "id"]);
  });
});

describe("collectRuntimeSnapshotAsync", () => {
  it("adds OpenClaw endpoint status and diagnostics", async () => {
    setRuntimes([
      {
        id: "openclaw-acp",
        displayName: "OpenClaw",
        binary: "openclaw",
        supportsRun: true,
        result: { available: true, version: "0.1.0" },
      },
    ]);

    const snap = await collectRuntimeSnapshotAsync({
      cfg: {
        openclawGateways: [
          { name: "ok", url: "ws://127.0.0.1:18789" },
          { name: "bad", url: "ws://127.0.0.1:16200" },
        ],
      },
      wsProbe: async ({ url }) =>
        url.includes("18789")
          ? { ok: true, version: "gw-1", agents: [{ id: "main" }] }
          : { ok: false, error: "connect rejected" },
    });

    const runtime = snap.runtimes.find((r) => r.id === "openclaw-acp");
    expect(runtime?.endpoints).toEqual([
      expect.objectContaining({
        name: "ok",
        reachable: true,
        status: "reachable",
        version: "gw-1",
        agents: [{ id: "main" }],
      }),
      expect.objectContaining({
        name: "bad",
        reachable: false,
        status: "unreachable",
        error: "connect rejected",
        diagnostics: [{ code: "gateway_unreachable", message: "connect rejected" }],
      }),
    ]);
  });

  it("marks OpenClaw agent profiles that already have a BotCord binding", async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "daemon-runtime-binding-"));
    const prevHome = process.env.HOME;
    process.env.HOME = tmp;
    try {
      mkdirSync(path.join(tmp, ".botcord", "credentials"), { recursive: true });
      writeFileSync(
        path.join(tmp, ".botcord", "credentials", "ag_bound.json"),
        JSON.stringify({
          hubUrl: "https://api.preview.botcord.chat",
          agentId: "ag_bound",
          keyId: "kid_bound",
          privateKey: Buffer.alloc(32, 1).toString("base64"),
          runtime: "openclaw-acp",
          openclawGateway: "local",
          openclawAgent: "swe",
        }),
      );
      setRuntimes([
        {
          id: "openclaw-acp",
          displayName: "OpenClaw",
          binary: "openclaw",
          supportsRun: true,
          result: { available: true },
        },
      ]);

      const snap = await collectRuntimeSnapshotAsync({
        cfg: { openclawGateways: [{ name: "local", url: "ws://127.0.0.1:18789" }] },
        wsProbe: async () => ({
          ok: true,
          agents: [{ id: "default" }, { id: "swe", name: "SWE" }],
        }),
      });

      const runtime = snap.runtimes.find((r) => r.id === "openclaw-acp");
      expect(runtime?.endpoints?.[0]?.agents).toEqual([
        { id: "default" },
        { id: "swe", name: "SWE", botcordBinding: { agentId: "ag_bound" } },
      ]);
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("reports acp_disabled without probing the gateway", async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "daemon-runtime-openclaw-"));
    const prevHome = process.env.HOME;
    process.env.HOME = tmp;
    try {
      mkdirSync(path.join(tmp, ".openclaw"), { recursive: true });
      writeFileSync(
        path.join(tmp, ".openclaw", "openclaw.json"),
        JSON.stringify({ acp: { enabled: false } }),
      );
      setRuntimes([
        {
          id: "openclaw-acp",
          displayName: "OpenClaw",
          binary: "openclaw",
          supportsRun: true,
          result: { available: true },
        },
      ]);
      const wsProbe = vi.fn(async () => ({ ok: true }));

      const snap = await collectRuntimeSnapshotAsync({
        cfg: { openclawGateways: [{ name: "local", url: "ws://127.0.0.1:18789" }] },
        wsProbe,
      });

      expect(wsProbe).not.toHaveBeenCalled();
      const runtime = snap.runtimes.find((r) => r.id === "openclaw-acp");
      expect(runtime?.endpoints).toEqual([
        expect.objectContaining({
          name: "local",
          reachable: false,
          status: "acp_disabled",
          error: "OpenClaw ACP runtime disabled",
          diagnostics: [
            {
              code: "acp_disabled",
              message: "OpenClaw config explicitly disables the ACP runtime",
            },
          ],
        }),
      ]);
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("reports missing_token when an OpenClaw gateway requires auth without a token", async () => {
    setRuntimes([
      {
        id: "openclaw-acp",
        displayName: "OpenClaw",
        binary: "openclaw",
        supportsRun: true,
        result: { available: true },
      },
    ]);

    const snap = await collectRuntimeSnapshotAsync({
      cfg: {
        openclawGateways: [{ name: "local", url: "ws://127.0.0.1:16200" }],
      },
      wsProbe: async () => ({
        ok: false,
        error: "unauthorized: gateway token missing (set gateway.remote.token to match gateway.auth.token)",
      }),
    });

    const runtime = snap.runtimes.find((r) => r.id === "openclaw-acp");
    expect(runtime?.endpoints).toEqual([
      expect.objectContaining({
        name: "local",
        reachable: false,
        status: "missing_token",
        error:
          "unauthorized: gateway token missing (set gateway.remote.token to match gateway.auth.token)",
        diagnostics: [
          {
            code: "missing_token",
            message:
              "OpenClaw gateway requires token; configure OPENCLAW_GATEWAY_TOKEN or tokenFile",
          },
        ],
      }),
    ]);
  });
});

interface FakeGateway {
  addChannel: ReturnType<typeof vi.fn>;
  removeChannel: ReturnType<typeof vi.fn>;
  snapshot: () => GatewayRuntimeSnapshot;
}

function makeFakeGateway(): FakeGateway {
  return {
    addChannel: vi.fn(async (_cfg: GatewayChannelConfig) => undefined),
    removeChannel: vi.fn(async (_id: string) => undefined),
    snapshot: (): GatewayRuntimeSnapshot => ({ channels: {}, turns: {} }),
  };
}

describe("provisioner list_runtimes handler", () => {
  it("acks with the collected runtime snapshot", async () => {
    setRuntimes([
      {
        id: "claude-code",
        displayName: "Claude Code",
        binary: "claude",
        supportsRun: true,
        result: { available: true, version: "1.0.0" },
      },
    ]);
    const gw = makeFakeGateway();
    const provisioner = createProvisioner({
      gateway: gw as unknown as Parameters<typeof createProvisioner>[0]["gateway"],
    });
    const ack = await provisioner({
      id: "req_rt_1",
      type: CONTROL_FRAME_TYPES.LIST_RUNTIMES,
      ts: Date.now(),
    });
    expect(ack.ok).toBe(true);
    const result = ack.result as {
      runtimes: Array<{ id: string; available: boolean; version?: string }>;
      probedAt: number;
    };
    expect(Array.isArray(result.runtimes)).toBe(true);
    expect(result.runtimes).toHaveLength(1);
    expect(result.runtimes[0]).toMatchObject({ id: "claude-code", available: true });
    expect(typeof result.probedAt).toBe("number");
  });
});

describe("pushRuntimeSnapshot (first-connect push)", () => {
  it("sends exactly one runtime_snapshot frame with the fresh probe payload", () => {
    setRuntimes([
      {
        id: "claude-code",
        displayName: "Claude Code",
        binary: "claude",
        supportsRun: true,
        result: { available: true, version: "1.0.0", path: "/usr/local/bin/claude" },
      },
    ]);
    const send = vi.fn(() => true);
    const ok = pushRuntimeSnapshot({ send });
    expect(ok).toBe(true);
    expect(send).toHaveBeenCalledOnce();
    const frame = send.mock.calls[0]![0] as {
      id: string;
      type: string;
      params: { runtimes: unknown[]; probedAt: number };
      ts: number;
    };
    expect(frame.type).toBe(CONTROL_FRAME_TYPES.RUNTIME_SNAPSHOT);
    expect(frame.id).toMatch(/^rt_/);
    expect(typeof frame.ts).toBe("number");
    expect(Array.isArray(frame.params.runtimes)).toBe(true);
    expect(frame.params.runtimes).toHaveLength(1);
    expect(typeof frame.params.probedAt).toBe("number");
  });

  it("returns false when the sink reports the WS is not open (non-fatal)", () => {
    setRuntimes([]);
    const send = vi.fn(() => false);
    const ok = pushRuntimeSnapshot({ send });
    expect(ok).toBe(false);
    expect(send).toHaveBeenCalledOnce();
  });
});
