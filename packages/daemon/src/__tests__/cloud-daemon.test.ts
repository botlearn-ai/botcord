/**
 * Integration test for {@link startCloudDaemon} — verifies wiring:
 *
 * - the control channel uses the `/cloud/daemon/ws` path
 * - it authenticates with the env-injected JWT (not on-disk user-auth)
 * - the provisioner is constructed and reachable via the channel's handler
 * - shutdown is idempotent
 *
 * Per-frame `provision_agent` / `revoke_agent` semantics live in
 * `provision.test.ts` — the cloud daemon reuses the same provisioner.
 */
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type WebSocket from "ws";
import { startCloudDaemon } from "../cloud-daemon.js";
import type { CloudModeConfig } from "../cloud-mode.js";
import { ControlChannel } from "../control-channel.js";
import type { DaemonConfig } from "../config.js";
import type { Gateway, GatewayChannelConfig } from "../gateway/index.js";

class FakeWebSocket extends EventEmitter {
  public readyState = 0;
  public sent: string[] = [];
  public closed = false;
  static OPEN = 1;
  constructor(public url: string, public opts: { headers?: Record<string, string> } = {}) {
    super();
    setImmediate(() => {
      this.readyState = FakeWebSocket.OPEN;
      this.emit("open");
    });
  }
  send(data: string): void {
    this.sent.push(data);
  }
  ping(): void {
    /* noop */
  }
  close(): void {
    this.closed = true;
    this.emit("close", 1000, Buffer.from("test"));
  }
  static readonly instances: FakeWebSocket[] = [];
}

function makeFakeCtor() {
  function Ctor(url: string, opts: { headers?: Record<string, string> } = {}) {
    const ws = new FakeWebSocket(url, opts);
    FakeWebSocket.instances.push(ws);
    return ws;
  }
  (Ctor as unknown as { OPEN: number }).OPEN = FakeWebSocket.OPEN;
  return Ctor as unknown as typeof WebSocket;
}

function makeCfg(): CloudModeConfig {
  return {
    // Loopback host is required by `normalizeAndValidateHubUrl` for http://.
    // Production cloud daemons use https://api.botcord.chat.
    hubUrl: "http://localhost:9000",
    cloudDaemonInstanceId: "cloud_dm_abc123",
    daemonInstanceId: "dm_abc123",
    accessToken: "tok_jwt_42",
  };
}

function makeDaemonCfg(): DaemonConfig {
  return {
    defaultRoute: { adapter: "deepseek-tui", cwd: os.homedir() },
    routes: [],
    streamBlocks: true,
  };
}

describe("startCloudDaemon", () => {
  let tmpDir: string;

  beforeEach(() => {
    FakeWebSocket.instances.length = 0;
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "cloud-daemon-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("dials /cloud/daemon/ws with the injected access token", async () => {
    const ctor = makeFakeCtor();
    // Inject a ControlChannel subclass that passes our fake WS through.
    class TestControlChannel extends ControlChannel {
      constructor(opts: ConstructorParameters<typeof ControlChannel>[0]) {
        super({
          ...opts,
          webSocketCtor: ctor,
          hubPublicKey: null,
        });
      }
    }

    const handle = await startCloudDaemon({
      cloudConfig: makeCfg(),
      config: makeDaemonCfg(),
      configPath: "(cloud-mode)",
      controlChannelFactory: TestControlChannel as unknown as typeof ControlChannel,
      sessionStorePath: path.join(tmpDir, "sessions.json"),
      snapshotPath: path.join(tmpDir, "snapshot.json"),
      snapshotIntervalMs: 60_000,
    });
    try {
      // The control channel connects asynchronously; let microtasks flush.
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      expect(FakeWebSocket.instances.length).toBeGreaterThanOrEqual(1);
      const ws = FakeWebSocket.instances[0]!;
      expect(ws.url).toBe("ws://localhost:9000/cloud/daemon/ws?label=cloud%3Acloud_dm_abc123");
      expect(ws.opts.headers?.Authorization).toBe("Bearer tok_jwt_42");
    } finally {
      await handle.stop("test");
    }
  });

  it("skips the control channel when disableControlChannel=true", async () => {
    const handle = await startCloudDaemon({
      cloudConfig: makeCfg(),
      config: makeDaemonCfg(),
      configPath: "(cloud-mode)",
      disableControlChannel: true,
      sessionStorePath: path.join(tmpDir, "sessions.json"),
      snapshotPath: path.join(tmpDir, "snapshot.json"),
      snapshotIntervalMs: 60_000,
    });
    try {
      await new Promise((r) => setImmediate(r));
      expect(FakeWebSocket.instances).toHaveLength(0);
      // Gateway should still be up — snapshot returns a sane object.
      const snap = handle.snapshot();
      expect(snap.channels).toEqual({});
    } finally {
      await handle.stop("test");
    }
  });

  it("uses the provided provisioner factory", async () => {
    const provisionerSpy = vi.fn();
    const factorySpy = vi.fn(() => provisionerSpy);
    const ctor = makeFakeCtor();
    class TestControlChannel extends ControlChannel {
      constructor(opts: ConstructorParameters<typeof ControlChannel>[0]) {
        super({ ...opts, webSocketCtor: ctor, hubPublicKey: null });
      }
    }
    const handle = await startCloudDaemon({
      cloudConfig: makeCfg(),
      config: makeDaemonCfg(),
      configPath: "(cloud-mode)",
      controlChannelFactory: TestControlChannel as unknown as typeof ControlChannel,
      provisionerFactory: factorySpy as unknown as typeof import("../provision.js").createProvisioner,
      sessionStorePath: path.join(tmpDir, "sessions.json"),
      snapshotPath: path.join(tmpDir, "snapshot.json"),
      snapshotIntervalMs: 60_000,
    });
    try {
      expect(factorySpy).toHaveBeenCalledOnce();
      const callArgs = factorySpy.mock.calls[0]![0] as Record<string, unknown>;
      expect(callArgs.gateway).toBeDefined();
      expect(callArgs.onAgentInstalled).toBeInstanceOf(Function);
      expect(callArgs.policyResolver).toBeDefined();
    } finally {
      await handle.stop("test");
    }
  });

  it.each(["telegram", "wechat", "feishu"] as const)(
    "allows %s gateway channels to be hot-plugged in cloud mode",
    async (type) => {
      let gateway: Pick<Gateway, "addChannel"> | undefined;
      const ctor = makeFakeCtor();
      class TestControlChannel extends ControlChannel {
        constructor(opts: ConstructorParameters<typeof ControlChannel>[0]) {
          super({ ...opts, webSocketCtor: ctor, hubPublicKey: null });
        }
      }
      const handle = await startCloudDaemon({
        cloudConfig: makeCfg(),
        config: makeDaemonCfg(),
        configPath: "(cloud-mode)",
        controlChannelFactory: TestControlChannel as unknown as typeof ControlChannel,
        provisionerFactory: ((args: { gateway: Gateway }) => {
          gateway = args.gateway;
          return vi.fn();
        }) as unknown as typeof import("../provision.js").createProvisioner,
        sessionStorePath: path.join(tmpDir, "sessions.json"),
        snapshotPath: path.join(tmpDir, "snapshot.json"),
        snapshotIntervalMs: 60_000,
      });
      try {
        expect(gateway).toBeDefined();
        const cfg: GatewayChannelConfig = {
          id: `gw_${type}_cloud`,
          type,
          accountId: "ag_cloud",
          allowedSenderIds: [type === "telegram" ? "42" : "alice"],
          secretFile: path.join(tmpDir, `missing-${type}-secret.json`),
        };
        if (type !== "wechat") {
          cfg.allowedChatIds = ["111"];
        }
        if (type === "feishu") {
          cfg.appId = "cli_test";
        }
        await expect(
          gateway!.addChannel(cfg),
        ).resolves.toBeUndefined();
      } finally {
        await handle.stop("test");
      }
    },
  );

  it("stop() is idempotent", async () => {
    const handle = await startCloudDaemon({
      cloudConfig: makeCfg(),
      config: makeDaemonCfg(),
      configPath: "(cloud-mode)",
      disableControlChannel: true,
      sessionStorePath: path.join(tmpDir, "sessions.json"),
      snapshotPath: path.join(tmpDir, "snapshot.json"),
      snapshotIntervalMs: 60_000,
    });
    await handle.stop("first");
    await handle.stop("second");
    // No throw is the assertion.
  });
});
