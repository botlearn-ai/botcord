import { chmodSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { derivePublicKey } from "./crypto.js";
import { normalizeAndValidateHubUrl } from "./hub-url.js";
import type { BotCordAccountConfig } from "./types.js";
import type { BotCordClient as BotCordClientType } from "./client.js";

export interface StoredBotCordCredentials {
  version: 1;
  hubUrl: string;
  agentId: string;
  keyId: string;
  privateKey: string;
  publicKey: string;
  displayName?: string;
  savedAt: string;
  token?: string;
  tokenExpiresAt?: number;
  onboardedAt?: string;
}

function normalizeCredentialValue(raw: any, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = raw?.[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

export function resolveCredentialsFilePath(credentialsFile: string): string {
  if (credentialsFile === "~") return os.homedir();
  if (credentialsFile.startsWith("~/")) {
    return path.join(os.homedir(), credentialsFile.slice(2));
  }
  return path.isAbsolute(credentialsFile)
    ? credentialsFile
    : path.resolve(credentialsFile);
}

export function defaultCredentialsFile(agentId: string): string {
  return path.join(os.homedir(), ".botcord", "credentials", `${agentId}.json`);
}

function readCredentialSource(credentialsFile: string): Record<string, unknown> {
  const resolved = resolveCredentialsFilePath(credentialsFile);
  try {
    return JSON.parse(readFileSync(resolved, "utf8")) as Record<string, unknown>;
  } catch (err: any) {
    throw new Error(`Unable to read BotCord credentials file "${resolved}": ${err.message}`);
  }
}

export function loadStoredCredentials(credentialsFile: string): StoredBotCordCredentials {
  const resolved = resolveCredentialsFilePath(credentialsFile);
  const raw = readCredentialSource(resolved);
  const hubUrl = normalizeCredentialValue(raw, ["hubUrl", "hub_url", "hub"]);
  const agentId = normalizeCredentialValue(raw, ["agentId", "agent_id"]);
  const keyId = normalizeCredentialValue(raw, ["keyId", "key_id"]);
  const privateKey = normalizeCredentialValue(raw, ["privateKey", "private_key"]);
  const publicKey = normalizeCredentialValue(raw, ["publicKey", "public_key"]);
  const displayName = normalizeCredentialValue(raw, ["displayName", "display_name"]);
  const savedAt = normalizeCredentialValue(raw, ["savedAt", "saved_at"]);
  const token = normalizeCredentialValue(raw, ["token"]);
  const tokenExpiresAt = typeof raw.tokenExpiresAt === "number"
    ? raw.tokenExpiresAt
    : typeof raw.token_expires_at === "number"
      ? raw.token_expires_at
      : undefined;

  if (!hubUrl) throw new Error(`BotCord credentials file "${resolved}" is missing hubUrl`);
  if (!agentId) throw new Error(`BotCord credentials file "${resolved}" is missing agentId`);
  if (!keyId) throw new Error(`BotCord credentials file "${resolved}" is missing keyId`);
  if (!privateKey) throw new Error(`BotCord credentials file "${resolved}" is missing privateKey`);

  const derivedPublicKey = derivePublicKey(privateKey);
  if (publicKey && publicKey !== derivedPublicKey) {
    throw new Error(
      `BotCord credentials file "${resolved}" has a publicKey that does not match privateKey`,
    );
  }

  let normalizedHubUrl: string;
  try {
    normalizedHubUrl = normalizeAndValidateHubUrl(hubUrl);
  } catch (err: any) {
    throw new Error(`BotCord credentials file "${resolved}" has an invalid hubUrl: ${err.message}`);
  }

  const onboardedAt = normalizeCredentialValue(raw, ["onboardedAt", "onboarded_at"]);

  return {
    version: 1,
    hubUrl: normalizedHubUrl,
    agentId,
    keyId,
    privateKey,
    publicKey: publicKey || derivedPublicKey,
    displayName,
    savedAt: savedAt || new Date().toISOString(),
    token,
    tokenExpiresAt,
    onboardedAt,
  };
}

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

export function writeCredentialsFile(
  credentialsFile: string,
  credentials: StoredBotCordCredentials,
): string {
  const resolved = resolveCredentialsFilePath(credentialsFile);
  const normalizedCredentials = {
    ...credentials,
    hubUrl: normalizeAndValidateHubUrl(credentials.hubUrl),
  };
  mkdirSync(path.dirname(resolved), { recursive: true, mode: 0o700 });
  writeFileSync(resolved, JSON.stringify(normalizedCredentials, null, 2) + "\n", {
    encoding: "utf8",
    mode: 0o600,
  });
  chmodSync(resolved, 0o600);
  return resolved;
}

/**
 * Atomically update only the token fields in an existing credentials file.
 * Reads current file, merges new token/expiresAt, writes back.
 * Returns false if the file does not exist or the write fails.
 */
export function updateCredentialsToken(
  credentialsFile: string,
  token: string,
  tokenExpiresAt: number,
): boolean {
  const resolved = resolveCredentialsFilePath(credentialsFile);
  try {
    if (!existsSync(resolved)) return false;
    const raw = JSON.parse(readFileSync(resolved, "utf8")) as Record<string, unknown>;
    raw.token = token;
    raw.tokenExpiresAt = tokenExpiresAt;
    writeFileSync(resolved, JSON.stringify(raw, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600,
    });
    chmodSync(resolved, 0o600);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check whether the agent has completed onboarding.
 */
export function isOnboarded(credentialsFile: string): boolean {
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
 * Mark the agent as onboarded by writing onboardedAt timestamp.
 */
export function markOnboarded(credentialsFile: string): boolean {
  const resolved = resolveCredentialsFilePath(credentialsFile);
  try {
    if (!existsSync(resolved)) return false;
    const raw = JSON.parse(readFileSync(resolved, "utf8")) as Record<string, unknown>;
    raw.onboardedAt = new Date().toISOString();
    writeFileSync(resolved, JSON.stringify(raw, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600,
    });
    chmodSync(resolved, 0o600);
    return true;
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
