import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { derivePublicKey } from "./crypto.js";
import type { BotCordAccountConfig } from "./types.js";

export interface StoredBotCordCredentials {
  version: 1;
  hubUrl: string;
  agentId: string;
  keyId: string;
  privateKey: string;
  publicKey: string;
  displayName?: string;
  savedAt: string;
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

  return {
    version: 1,
    hubUrl,
    agentId,
    keyId,
    privateKey,
    publicKey: publicKey || derivedPublicKey,
    displayName,
    savedAt: savedAt || new Date().toISOString(),
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
  mkdirSync(path.dirname(resolved), { recursive: true, mode: 0o700 });
  writeFileSync(resolved, JSON.stringify(credentials, null, 2) + "\n", {
    encoding: "utf8",
    mode: 0o600,
  });
  chmodSync(resolved, 0o600);
  return resolved;
}
