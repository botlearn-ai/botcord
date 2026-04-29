import { chmodSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
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
  onboardedAt?: string;
  /**
   * Runtime bound to this agent (claude-code / codex / gemini / …). Cached
   * from the Hub-side `agents.runtime` column so daemon can route turns
   * offline. Only set for agents created via the daemon provision path; old
   * bind-code credentials have no value here. Authoritative source is Hub.
   */
  runtime?: string;
  /** Working directory pinned for this agent, cached alongside runtime. */
  cwd?: string;
  /**
   * Name of the OpenClaw gateway profile (`DaemonConfig.openclawGateways[].name`)
   * to route this agent's turns through. Only meaningful when `runtime ===
   * "openclaw-acp"`. Read by `buildManagedRoutes` to lookup the resolved
   * gateway endpoint at config-load time.
   */
  openclawGateway?: string;
  /**
   * Optional override of the OpenClaw agent profile to use within the gateway,
   * falling back to `OpenclawGatewayProfile.defaultAgent` when absent.
   */
  openclawAgent?: string;
  /**
   * Hermes profile this agent is attached to (`~/.hermes/profiles/<name>/`,
   * or `~/.hermes` when the value is `"default"`). Only meaningful when
   * `runtime === "hermes-agent"`. Read by the daemon's hermes adapter to
   * route `HERMES_HOME` at spawn time so the BotCord agent shares state
   * with the user's command-line `hermes`.
   */
  hermesProfile?: string;
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
  const runtime = normalizeCredentialValue(raw, ["runtime"]);
  const cwd = normalizeCredentialValue(raw, ["cwd"]);
  const openclawGateway = normalizeCredentialValue(raw, ["openclawGateway", "openclaw_gateway"]);
  const openclawAgent = normalizeCredentialValue(raw, ["openclawAgent", "openclaw_agent"]);
  const hermesProfile = normalizeCredentialValue(raw, ["hermesProfile", "hermes_profile"]);

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
    runtime,
    cwd,
    openclawGateway,
    openclawAgent,
    hermesProfile,
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
