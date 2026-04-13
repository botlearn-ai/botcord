import { existsSync, mkdirSync, symlinkSync, unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  loadStoredCredentials,
  defaultCredentialsFile,
} from "@botcord/protocol-core";

// Re-export core functions so existing CLI imports don't break
export {
  type StoredBotCordCredentials,
  loadStoredCredentials,
  defaultCredentialsFile,
  writeCredentialsFile,
  resolveCredentialsFilePath,
} from "@botcord/protocol-core";

// CLI-specific helpers below

const DEFAULT_LINK = path.join(os.homedir(), ".botcord", "default.json");

export function loadDefaultCredentials(agentId?: string) {
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
