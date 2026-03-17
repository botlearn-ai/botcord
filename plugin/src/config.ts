/**
 * Configuration resolution for BotCord channel.
 * The runtime still understands both flat and account-mapped config shapes,
 * but the plugin currently operates in single-account mode.
 */
import {
  readCredentialFileData,
  resolveCredentialsFilePath,
} from "./credentials.js";
import type { BotCordAccountConfig, BotCordChannelConfig } from "./types.js";

export const SINGLE_ACCOUNT_ONLY_MESSAGE =
  "BotCord currently supports only a single configured account. Multi-account support is planned for a future update.";

export function resolveChannelConfig(cfg: any): BotCordChannelConfig {
  return (cfg?.channels?.botcord ?? {}) as BotCordChannelConfig;
}

function hydrateAccountConfig(acct: BotCordAccountConfig): BotCordAccountConfig {
  const credentialsFile = acct.credentialsFile
    ? resolveCredentialsFilePath(acct.credentialsFile)
    : undefined;
  const fileData = readCredentialFileData(credentialsFile);
  const inlineData = Object.fromEntries(
    Object.entries(acct).filter(([, value]) => value !== undefined),
  ) as BotCordAccountConfig;
  return {
    ...fileData,
    ...inlineData,
    credentialsFile,
  };
}

/** Resolve all account configs from either flat or account-mapped config. */
export function resolveAccounts(
  channelCfg: BotCordChannelConfig,
): Record<string, BotCordAccountConfig> {
  if (channelCfg.accounts && Object.keys(channelCfg.accounts).length > 0) {
    return Object.fromEntries(
      Object.entries(channelCfg.accounts).map(([accountId, acct]) => [
        accountId,
        hydrateAccountConfig(acct),
      ]),
    );
  }
  // Single-account fallback
  return {
    default: hydrateAccountConfig({
      enabled: channelCfg.enabled,
      credentialsFile: channelCfg.credentialsFile,
      hubUrl: channelCfg.hubUrl,
      agentId: channelCfg.agentId,
      keyId: channelCfg.keyId,
      privateKey: channelCfg.privateKey,
      publicKey: channelCfg.publicKey,
      deliveryMode: channelCfg.deliveryMode,
      pollIntervalMs: channelCfg.pollIntervalMs,
      allowFrom: channelCfg.allowFrom,
      notifySession: channelCfg.notifySession,
    }),
  };
}

export function resolveAccountConfig(
  cfg: any,
  accountId?: string,
): BotCordAccountConfig {
  const channelCfg = resolveChannelConfig(cfg);
  const accounts = resolveAccounts(channelCfg);
  const id = accountId || "default";
  return accounts[id] || accounts[Object.keys(accounts)[0]] || {};
}

export function isAccountConfigured(acct: BotCordAccountConfig): boolean {
  return !!(acct.hubUrl && acct.agentId && acct.keyId && acct.privateKey);
}

export function countAccounts(cfg: any): number {
  const channelCfg = resolveChannelConfig(cfg);
  return Object.keys(resolveAccounts(channelCfg)).length;
}

export function getSingleAccountModeError(cfg: any): string | null {
  return countAccounts(cfg) > 1 ? SINGLE_ACCOUNT_ONLY_MESSAGE : null;
}

/** Display prefix for logs and messages. */
export function displayPrefix(accountId: string, cfg: any): string {
  const total = countAccounts(cfg);
  if (total <= 1 && accountId === "default") return "BotCord";
  return `BotCord:${accountId}`;
}
