import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import type { DaemonConfig } from "../config.js";
import { LoginSessionStore } from "../gateway/channels/login-session.js";
import { createGatewayControl } from "../gateway-control.js";

// `secret-store.ts` resolves `DEFAULT_GATEWAYS_DIR` via `homedir()` at module
// load, so a `process.env.HOME` override in `beforeEach` doesn't redirect
// writes — we have to clean up under the real home instead.
const realGatewaysDir = path.join(homedir(), ".botcord", "daemon", "gateways");
const trackedSecrets = new Set<string>();

function trackSecret(id: string): string {
  const p = path.join(realGatewaysDir, `${id}.json`);
  trackedSecrets.add(p);
  return p;
}

// Use a unique gateway-id prefix per test run so concurrent vitest workers
// don't trample each other's secret files.
const TEST_RUN_ID = `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
let testCounter = 0;
function uniqId(label: string): string {
  testCounter += 1;
  return `gw_${label}_${TEST_RUN_ID}_${testCounter}`;
}

afterEach(() => {
  for (const p of trackedSecrets) {
    try {
      unlinkSync(p);
    } catch {
      // best-effort
    }
  }
  trackedSecrets.clear();
});

interface FakeGateway {
  channels: Map<string, { id: string; status: Record<string, unknown> }>;
  addChannel: ReturnType<typeof vi.fn>;
  removeChannel: ReturnType<typeof vi.fn>;
  snapshot: () => { channels: Record<string, any>; turns: Record<string, any> };
}

function makeFakeGateway(): FakeGateway {
  const channels = new Map<string, { id: string; status: Record<string, unknown> }>();
  return {
    channels,
    addChannel: vi.fn(async (cfg: { id: string; accountId: string }) => {
      channels.set(cfg.id, {
        id: cfg.id,
        status: {
          channel: cfg.id,
          accountId: cfg.accountId,
          running: true,
          connected: true,
          authorized: true,
          lastPollAt: Date.now(),
        },
      });
    }),
    removeChannel: vi.fn(async (id: string) => {
      channels.delete(id);
    }),
    snapshot: () => ({
      channels: Object.fromEntries([...channels].map(([id, e]) => [id, e.status])),
      turns: {},
    }),
  };
}

function makeConfigIO(initial: DaemonConfig) {
  const state = { cfg: JSON.parse(JSON.stringify(initial)) as DaemonConfig };
  return {
    state,
    io: {
      load: () => JSON.parse(JSON.stringify(state.cfg)) as DaemonConfig,
      save: (next: DaemonConfig) => {
        state.cfg = JSON.parse(JSON.stringify(next)) as DaemonConfig;
      },
    },
  };
}

const baseCfg = (): DaemonConfig => ({
  agents: ["ag_alice"],
  defaultRoute: { adapter: "claude-code", cwd: "/tmp" },
  routes: [],
  streamBlocks: false,
});

describe("upsert_gateway", () => {
  it("(a) telegram secret writes file with mode 0600 and hot-plugs the channel", async () => {
    const gw = makeFakeGateway();
    const { state, io } = makeConfigIO(baseCfg());
    const ctrl = createGatewayControl({ gateway: gw as any, configIO: io });
    const gwId = uniqId("tg");

    const ack = await ctrl.handleUpsert({
      id: gwId,
      type: "telegram",
      accountId: "ag_alice",
      label: "My TG",
      enabled: true,
      secret: { botToken: "111:abcdefghijklmnop" },
      settings: { allowedChatIds: ["123"] },
    });

    expect(ack.ok).toBe(true);
    const result = ack.result as { id: string; tokenPreview: string; status?: any };
    expect(result.id).toBe(gwId);
    expect(result.tokenPreview).toBe("111:...mnop");

    const secretPath = trackSecret(gwId);
    expect(existsSync(secretPath)).toBe(true);
    const mode = statSync(secretPath).mode & 0o777;
    expect(mode).toBe(0o600);
    const onDisk = JSON.parse(readFileSync(secretPath, "utf8"));
    expect(onDisk.botToken).toBe("111:abcdefghijklmnop");

    expect(gw.addChannel).toHaveBeenCalledOnce();
    expect(gw.channels.has(gwId)).toBe(true);

    expect(state.cfg.thirdPartyGateways).toHaveLength(1);
    expect(state.cfg.thirdPartyGateways![0].id).toBe(gwId);
    expect(state.cfg.thirdPartyGateways![0].label).toBe("My TG");
  });

  it("(b) wechat upsert with mismatched accountId is rejected", async () => {
    const gw = makeFakeGateway();
    const { io } = makeConfigIO(baseCfg());
    const sessions = new LoginSessionStore();
    sessions.create({
      loginId: "wxl_1",
      accountId: "ag_other",
      provider: "wechat",
      qrcode: "QR",
      baseUrl: "https://ilinkai.weixin.qq.com",
      botToken: "wechat-bot-token-1234",
    });
    const ctrl = createGatewayControl({
      gateway: gw as any,
      configIO: io,
      loginSessions: sessions,
    });

    const ack = await ctrl.handleUpsert({
      id: "gw_wx_1",
      type: "wechat",
      accountId: "ag_alice",
      enabled: true,
      loginId: "wxl_1",
    });

    expect(ack.ok).toBe(false);
    expect(ack.error?.code).toBe("login_account_mismatch");
    expect(gw.addChannel).not.toHaveBeenCalled();
  });
});

describe("remove_gateway", () => {
  it("(c) deletes secret file and removes channel + config entry", async () => {
    const gw = makeFakeGateway();
    const gwId = uniqId("rm");
    const { state, io } = makeConfigIO(baseCfg());
    const ctrl = createGatewayControl({ gateway: gw as any, configIO: io });
    await ctrl.handleUpsert({
      id: gwId,
      type: "telegram",
      accountId: "ag_alice",
      enabled: true,
      secret: { botToken: "111:abcdefghijklmnop" },
    });
    const secretPath = trackSecret(gwId);
    expect(existsSync(secretPath)).toBe(true);
    expect(gw.channels.has(gwId)).toBe(true);

    const ack = await ctrl.handleRemove({ id: gwId });
    expect(ack.ok).toBe(true);
    const result = ack.result as { removed: boolean; secretDeleted: boolean };
    expect(result.removed).toBe(true);
    expect(result.secretDeleted).toBe(true);
    expect(existsSync(secretPath)).toBe(false);
    expect(gw.channels.has(gwId)).toBe(false);
    expect(state.cfg.thirdPartyGateways ?? []).toHaveLength(0);
  });
});

describe("gateway_login_start / status", () => {
  it("(d) round-trip with mocked iLink fetch returns confirmed + tokenPreview, never the bot token", async () => {
    const gw = makeFakeGateway();
    const { io } = makeConfigIO(baseCfg());
    const sessions = new LoginSessionStore();
    const wechatLogin = {
      getBotQrcode: vi.fn(async () => ({
        qrcode: "QR-OPAQUE",
        qrcodeUrl: "https://example/qr.png",
        raw: {},
      })),
      getQrcodeStatus: vi.fn(async () => ({
        status: "confirmed",
        botToken: "wechat-bot-token-1234567890",
        baseUrl: "https://ilinkai.weixin.qq.com",
        raw: {},
      })),
    };
    const ctrl = createGatewayControl({
      gateway: gw as any,
      configIO: io,
      loginSessions: sessions,
      wechatLoginClient: wechatLogin,
    });

    const startAck = await ctrl.handleLoginStart({
      provider: "wechat",
      accountId: "ag_alice",
    });
    expect(startAck.ok).toBe(true);
    const startResult = startAck.result as { loginId: string; qrcode: string; qrcodeUrl?: string; expiresAt: number };
    expect(startResult.loginId).toMatch(/^wxl_/);
    expect(startResult.qrcode).toBe("QR-OPAQUE");
    expect(startResult.qrcodeUrl).toBe("https://example/qr.png");
    expect(startResult.expiresAt).toBeGreaterThan(Date.now());

    const statusAck = await ctrl.handleLoginStatus({
      provider: "wechat",
      loginId: startResult.loginId,
    });
    expect(statusAck.ok).toBe(true);
    const statusResult = statusAck.result as { status: string; tokenPreview?: string; baseUrl?: string };
    expect(statusResult.status).toBe("confirmed");
    expect(statusResult.tokenPreview).toBe("wech...7890");
    expect(statusResult.baseUrl).toBe("https://ilinkai.weixin.qq.com");
    // Bot token never escapes the daemon.
    expect(JSON.stringify(statusResult)).not.toContain("wechat-bot-token-1234567890");
  });
});

describe("frame schema validation", () => {
  it("(e) login_start rejects unknown provider", async () => {
    const gw = makeFakeGateway();
    const { io } = makeConfigIO(baseCfg());
    const ctrl = createGatewayControl({ gateway: gw as any, configIO: io });

    const ack = await ctrl.handleLoginStart({
      // @ts-expect-error — exercising the runtime guard
      provider: "line",
      accountId: "ag_alice",
    });
    expect(ack.ok).toBe(false);
    expect(ack.error?.code).toBe("bad_params");
    expect(ack.error?.message).toContain("unknown provider");
  });

  it("upsert rejects unknown provider", async () => {
    const gw = makeFakeGateway();
    const { io } = makeConfigIO(baseCfg());
    const ctrl = createGatewayControl({ gateway: gw as any, configIO: io });

    const ack = await ctrl.handleUpsert({
      id: "gw_x",
      // @ts-expect-error — exercising the runtime guard
      type: "discord",
      accountId: "ag_alice",
      enabled: true,
    });
    expect(ack.ok).toBe(false);
    expect(ack.error?.code).toBe("bad_params");
  });
});

describe("list_gateways", () => {
  it("returns config entries annotated with live channel status", async () => {
    const gw = makeFakeGateway();
    const { io } = makeConfigIO(baseCfg());
    const ctrl = createGatewayControl({ gateway: gw as any, configIO: io });

    const gwId = uniqId("ls");
    trackSecret(gwId);
    await ctrl.handleUpsert({
      id: gwId,
      type: "telegram",
      accountId: "ag_alice",
      enabled: true,
      secret: { botToken: "111:abcdefghijklmnop" },
      settings: { allowedChatIds: ["c1"] },
      label: "TG",
    });

    const ack = ctrl.handleList();
    expect(ack.ok).toBe(true);
    const result = ack.result as { gateways: Array<any> };
    expect(result.gateways).toHaveLength(1);
    const g = result.gateways[0];
    expect(g.id).toBe(gwId);
    expect(g.type).toBe("telegram");
    expect(g.label).toBe("TG");
    expect(g.allowedChatIds).toEqual(["c1"]);
    expect(g.enabled).toBe(true);
    expect(g.status?.running).toBe(true);
    expect(g.status?.authorized).toBe(true);
  });
});
