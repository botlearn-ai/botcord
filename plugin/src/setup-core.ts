import {
  DEFAULT_ACCOUNT_ID,
  type ChannelSetupAdapter,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/setup";
import type { BotCordChannelConfig } from "./types.js";

export const botCordSetupAdapter: ChannelSetupAdapter = {
  resolveAccountId: () => DEFAULT_ACCOUNT_ID,
  applyAccountConfig: ({ cfg, accountId }) => {
    const isDefault = !accountId || accountId === DEFAULT_ACCOUNT_ID;
    if (isDefault) {
      return {
        ...cfg,
        channels: {
          ...cfg.channels,
          botcord: {
            ...cfg.channels?.botcord,
            enabled: true,
          },
        },
      };
    }
    const botcordCfg = cfg.channels?.botcord as BotCordChannelConfig | undefined;
    return {
      ...cfg,
      channels: {
        ...cfg.channels,
        botcord: {
          ...botcordCfg,
          accounts: {
            ...botcordCfg?.accounts,
            [accountId]: {
              ...botcordCfg?.accounts?.[accountId],
              enabled: true,
            },
          },
        },
      },
    };
  },
};
