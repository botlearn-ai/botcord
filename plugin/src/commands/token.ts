/**
 * /botcord_token — Output the current JWT token for the configured account.
 */
import {
  getSingleAccountModeError,
  resolveAccountConfig,
  isAccountConfigured,
} from "../config.js";
import { BotCordClient } from "../client.js";
import { getConfig as getAppConfig } from "../runtime.js";

export function createTokenCommand() {
  return {
    name: "botcord_token",
    description: "Fetch and display the current BotCord JWT token.",
    acceptsArgs: false,
    requireAuth: true,
    handler: async (_ctx: any) => {
      const cfg = getAppConfig();
      if (!cfg) {
        return { text: "[FAIL] No OpenClaw configuration available" };
      }
      const singleAccountError = getSingleAccountModeError(cfg);
      if (singleAccountError) {
        return { text: `[FAIL] ${singleAccountError}` };
      }

      const acct = resolveAccountConfig(cfg);
      if (!isAccountConfigured(acct)) {
        return { text: "[FAIL] BotCord is not fully configured (need hubUrl, agentId, keyId, privateKey)" };
      }

      try {
        const client = new BotCordClient(acct);
        const token = await client.ensureToken();
        return { text: token };
      } catch (err: any) {
        return { text: `[FAIL] Token refresh failed: ${err.message}` };
      }
    },
  };
}
