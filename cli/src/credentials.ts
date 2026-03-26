import { chmodSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, unlinkSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { derivePublicKey } from "./crypto.js";
import { normalizeAndValidateHubUrl } from "./hub-url.js";

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
}

function normalizeCredentialValue(raw: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = raw[key];
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

export function loadStoredCredentials(credentialsFile: string): StoredBotCordCredentials {
  const resolved = resolveCredentialsFilePath(credentialsFile);
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(resolved, "utf8")) as Record<string, unknown>;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Unable to read BotCord credentials file "${resolved}": ${msg}`);
  }

  const hubUrl = normalizeCredentialValue(raw, ["hubUrl", "hub_url", "hub"]);
  const agentId = normalizeCredentialValue(raw, ["agentId", "agent_id"]);
  const keyId = normalizeCredentialValue(raw, ["keyId", "key_id"]);
  const privateKey = normalizeCredentialValue(raw, ["privateKey", "private_key"]);
  const publicKey = normalizeCredentialValue(raw, ["publicKey", "public_key"]);
  const displayName = normalizeCredentialValue(raw, ["displayName", "display_name"]);
  const savedAt = normalizeCredentialValue(raw, ["savedAt", "saved_at"]);
  const token = normalizeCredentialValue(raw, ["token"]);
  const tokenExpiresAt = typeof raw.tokenExpiresAt === "number" ? raw.tokenExpiresAt : undefined;

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
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`BotCord credentials file "${resolved}" has an invalid hubUrl: ${msg}`);
  }

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
  };
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

const DEFAULT_LINK = path.join(os.homedir(), ".botcord", "default.json");

export function loadDefaultCredentials(agentId?: string): StoredBotCordCredentials {
  if (agentId) {
    return loadStoredCredentials(defaultCredentialsFile(agentId));
  }
  if (!existsSync(DEFAULT_LINK)) {
    throw new Error("No default agent configured. Use --agent <id> or run: botcord register --set-default");
  }
  return loadStoredCredentials(DEFAULT_LINK);
}

export function setDefaultAgent(agentId: string): void {
  const target = defaultCredentialsFile(agentId);
  if (!existsSync(target)) {
    throw new Error(`Credentials file not found: ${target}`);
  }
  const linkDir = path.dirname(DEFAULT_LINK);
  mkdirSync(linkDir, { recursive: true, mode: 0o700 });
  if (existsSync(DEFAULT_LINK)) {
    unlinkSync(DEFAULT_LINK);
  }
  symlinkSync(target, DEFAULT_LINK);
}
