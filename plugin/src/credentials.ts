import { existsSync, readFileSync } from "node:fs";
import {
  type StoredBotCordCredentials,
  updateCredentialsToken,
  loadStoredCredentials,
  writeCredentialsFile,
  resolveCredentialsFilePath,
  defaultCredentialsFile,
} from "@botcord/protocol-core";
import type { BotCordAccountConfig } from "./types.js";
import type { BotCordClient as BotCordClientType } from "./client.js";

// Re-export core functions so existing plugin imports don't break
export {
  type StoredBotCordCredentials,
  updateCredentialsToken,
  loadStoredCredentials,
  writeCredentialsFile,
  resolveCredentialsFilePath,
  defaultCredentialsFile,
} from "@botcord/protocol-core";

// Plugin-specific helpers below

export function readCredentialFileData(credentialsFile?: string): Partial<BotCordAccountConfig> {
  if (!credentialsFile) return {};

  try {
    const raw = loadStoredCredentials(credentialsFile);
    return {
      hubUrl: raw.hubUrl,
      agentId: raw.agentId,
      keyId: raw.keyId,
      privateKey: raw.privateKey,
      publicKey: raw.publicKey,
      token: raw.token,
      tokenExpiresAt: raw.tokenExpiresAt,
    };
  } catch {
    return {};
  }
}

/**
 * Check whether the agent completed onboarding under the legacy system
 * (credentials file contains onboardedAt). Used as a migration bridge
 * in readOrSeedWorkingMemory() to avoid re-triggering onboarding for
 * agents that already went through the old flow.
 *
 * Read-only — this function never writes to the credentials file.
 */
export function isLegacyOnboarded(credentialsFile: string): boolean {
  const resolved = resolveCredentialsFilePath(credentialsFile);
  try {
    if (!existsSync(resolved)) return false;
    const raw = JSON.parse(readFileSync(resolved, "utf8")) as Record<string, unknown>;
    return !!(raw.onboardedAt || raw.onboarded_at);
  } catch {
    return false;
  }
}

/**
 * Attach token persistence to a BotCordClient.
 * If the account was loaded from a credentialsFile, refreshed tokens
 * are automatically written back to that file.
 */
export function attachTokenPersistence(
  client: BotCordClientType,
  acct: BotCordAccountConfig,
): void {
  if (!acct.credentialsFile) return;
  const credFile = acct.credentialsFile;
  client.onTokenRefresh = (token, expiresAt) => {
    updateCredentialsToken(credFile, token, expiresAt);
  };
}
