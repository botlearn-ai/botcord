/**
 * /botcord_env — View or switch the BotCord Hub environment.
 *
 * Usage:
 *   /botcord_env              — show current hub URL and environment
 *   /botcord_env stable       — switch to stable (api.botcord.chat)
 *   /botcord_env beta         — switch to beta (preview.botcord.chat)
 *   /botcord_env test         — switch to test (test.botcord.chat)
 *   /botcord_env <url>        — switch to a custom hub URL
 *
 * Changes are written to the credentials file. Restart gateway to take effect.
 */
import { ENV_PRESETS } from "../constants.js";
import {
  resolveAccountConfig,
  isAccountConfigured,
} from "../config.js";
import {
  loadStoredCredentials,
  writeCredentialsFile,
} from "../credentials.js";
import { normalizeAndValidateHubUrl } from "../hub-url.js";
import { getConfig as getAppConfig } from "../runtime.js";

function resolveEnvLabel(hubUrl: string): string | null {
  for (const [name, url] of Object.entries(ENV_PRESETS)) {
    if (hubUrl === url) return name;
  }
  return null;
}

export function createEnvCommand() {
  return {
    name: "botcord_env",
    description: "View or switch the BotCord Hub environment (stable/beta/test or custom URL).",
    acceptsArgs: true,
    requireAuth: true,
    handler: async (ctx: any) => {
      const cfg = getAppConfig();
      if (!cfg) {
        return { text: "[FAIL] No OpenClaw configuration available" };
      }

      const acct = resolveAccountConfig(cfg);
      if (!isAccountConfigured(acct)) {
        return { text: "[FAIL] BotCord is not fully configured (need hubUrl, agentId, keyId, privateKey)" };
      }

      const arg = (ctx.args || "").trim();

      // ── No argument: show current environment ──
      if (!arg) {
        const current = acct.hubUrl || "(not set)";
        const label = acct.hubUrl ? resolveEnvLabel(acct.hubUrl) : null;
        const envDisplay = label ? ` (${label})` : "";
        const presetList = Object.entries(ENV_PRESETS)
          .map(([name, url]) => `  ${name} → ${url}`)
          .join("\n");
        return {
          text: [
            `Current hub: ${current}${envDisplay}`,
            "",
            "Available environments:",
            presetList,
            "",
            "Usage: /botcord_env <stable|beta|test|URL>",
          ].join("\n"),
        };
      }

      // ── Resolve target URL ──
      const targetUrl = ENV_PRESETS[arg] || arg;

      let normalizedUrl: string;
      try {
        normalizedUrl = normalizeAndValidateHubUrl(targetUrl);
      } catch (err: any) {
        return { text: `[FAIL] Invalid hub URL: ${err.message}` };
      }

      // ── Check if already on this URL ──
      if (acct.hubUrl === normalizedUrl) {
        const label = resolveEnvLabel(normalizedUrl);
        const envDisplay = label ? ` (${label})` : "";
        return { text: `Already on ${normalizedUrl}${envDisplay}. No change needed.` };
      }

      // ── Write to credentials file ──
      if (!acct.credentialsFile) {
        return { text: "[FAIL] No credentials file configured — cannot persist hub URL change" };
      }

      try {
        const creds = loadStoredCredentials(acct.credentialsFile);
        creds.hubUrl = normalizedUrl;
        writeCredentialsFile(acct.credentialsFile, creds);
      } catch (err: any) {
        return { text: `[FAIL] Could not update credentials file: ${err.message}` };
      }

      const label = resolveEnvLabel(normalizedUrl);
      const envDisplay = label ? ` (${label})` : "";
      return {
        text: `[OK] Hub URL updated to ${normalizedUrl}${envDisplay}. Restart gateway to take effect.`,
      };
    },
  };
}
