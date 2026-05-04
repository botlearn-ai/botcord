import { describe, expect, it } from "vitest";
import type { DaemonConfig } from "../config.js";
import {
  BOTCORD_CHANNEL_TYPE,
  TELEGRAM_CHANNEL_TYPE,
  WECHAT_CHANNEL_TYPE,
  toGatewayConfig,
} from "../daemon-config-map.js";
import { createDaemonChannel } from "../daemon.js";
import type { GatewayChannelConfig } from "../gateway/index.js";

function baseConfig(partial: Partial<DaemonConfig> = {}): DaemonConfig {
  return {
    agentId: "ag_daemon",
    defaultRoute: { adapter: "claude-code", cwd: "/home/alice" },
    routes: [],
    streamBlocks: true,
    ...partial,
  };
}

describe("toGatewayConfig + thirdPartyGateways", () => {
  it("appends one channel per enabled third-party gateway after the BotCord channels", () => {
    const cfg = baseConfig({
      thirdPartyGateways: [
        {
          id: "gw_tg_1",
          type: "telegram",
          accountId: "ag_daemon",
          allowedChatIds: ["123"],
        },
        {
          id: "gw_wx_1",
          type: "wechat",
          accountId: "ag_daemon",
          baseUrl: "https://ilinkai.weixin.qq.com",
          allowedSenderIds: ["abc@im.wechat"],
          splitAt: 1800,
        },
      ],
    });
    const gw = toGatewayConfig(cfg);
    expect(gw.channels.map((c) => ({ id: c.id, type: c.type }))).toEqual([
      { id: "ag_daemon", type: BOTCORD_CHANNEL_TYPE },
      { id: "gw_tg_1", type: TELEGRAM_CHANNEL_TYPE },
      { id: "gw_wx_1", type: WECHAT_CHANNEL_TYPE },
    ]);
    const tg = gw.channels[1]!;
    expect(tg.accountId).toBe("ag_daemon");
    expect(tg.allowedChatIds).toEqual(["123"]);
    const wx = gw.channels[2]!;
    expect(wx.baseUrl).toBe("https://ilinkai.weixin.qq.com");
    expect(wx.allowedSenderIds).toEqual(["abc@im.wechat"]);
    expect(wx.splitAt).toBe(1800);
  });

  it("filters out gateways with enabled === false", () => {
    const cfg = baseConfig({
      thirdPartyGateways: [
        { id: "gw_off", type: "telegram", accountId: "ag_daemon", enabled: false },
        { id: "gw_on", type: "wechat", accountId: "ag_daemon", enabled: true },
      ],
    });
    const gw = toGatewayConfig(cfg);
    const ids = gw.channels.map((c) => c.id);
    expect(ids).toContain("gw_on");
    expect(ids).not.toContain("gw_off");
  });

  it("treats omitted enabled as enabled", () => {
    const cfg = baseConfig({
      thirdPartyGateways: [{ id: "gw_a", type: "telegram", accountId: "ag_daemon" }],
    });
    const gw = toGatewayConfig(cfg);
    expect(gw.channels.some((c) => c.id === "gw_a")).toBe(true);
  });
});

describe("createDaemonChannel", () => {
  const deps = {
    credentialPathByAgentId: new Map<string, string>(),
  };

  it("dispatches botcord type to the BotCord adapter", () => {
    const chCfg: GatewayChannelConfig = {
      id: "ag_x",
      type: "botcord",
      accountId: "ag_x",
      agentId: "ag_x",
    };
    const adapter = createDaemonChannel(chCfg, deps);
    expect(adapter.type).toBe("botcord");
    expect(adapter.id).toBe("ag_x");
  });

  it("dispatches telegram type to the Telegram adapter", () => {
    const chCfg: GatewayChannelConfig = {
      id: "gw_tg_1",
      type: "telegram",
      accountId: "ag_x",
    };
    const adapter = createDaemonChannel(chCfg, deps);
    expect(adapter.type).toBe("telegram");
    expect(adapter.id).toBe("gw_tg_1");
  });

  it("dispatches wechat type to the WeChat adapter", () => {
    const chCfg: GatewayChannelConfig = {
      id: "gw_wx_1",
      type: "wechat",
      accountId: "ag_x",
    };
    const adapter = createDaemonChannel(chCfg, deps);
    expect(adapter.type).toBe("wechat");
    expect(adapter.id).toBe("gw_wx_1");
  });

  it("throws on unknown channel type", () => {
    const chCfg: GatewayChannelConfig = {
      id: "gw_x",
      type: "unknown-provider",
      accountId: "ag_x",
    };
    expect(() => createDaemonChannel(chCfg, deps)).toThrow(/unknown channel type "unknown-provider"/);
  });
});
