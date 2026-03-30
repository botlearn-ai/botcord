import { readdir } from "node:fs/promises";
import { resolve, basename } from "node:path";
import type { AssertionResult, InstanceEvidence, InstanceState, EnvironmentConfig } from "../types.js";

function makeResult(
  id: string,
  instanceId: string,
  passed: boolean,
  expected: unknown,
  actual: unknown,
  evidence?: string,
): AssertionResult {
  return { id, instanceId, status: passed ? "passed" : "failed", expected, actual, evidence };
}

export async function assertPluginInstallPresent(inst: InstanceState, evidence: InstanceEvidence): Promise<AssertionResult> {
  // Check for actual plugin files on disk, not just config
  const pluginsDir = resolve(inst.instanceDir, ".openclaw", "plugins");
  const extensionsDir = resolve(inst.instanceDir, ".openclaw", "extensions");
  let found = false;
  let location = "";

  for (const dir of [pluginsDir, extensionsDir]) {
    try {
      const files = await readdir(dir, { recursive: true });
      const hasBotcord = files.some(f => f.includes("botcord"));
      if (hasBotcord) {
        found = true;
        location = dir;
        break;
      }
    } catch {
      // directory may not exist
    }
  }

  return makeResult(
    "plugin.install_present",
    inst.id,
    found,
    "BotCord plugin files exist on disk",
    found ? `found in ${location}` : "not found in plugins/ or extensions/",
  );
}

export function assertBotcordEnabled(inst: InstanceState, evidence: InstanceEvidence): AssertionResult {
  const config = evidence.openclawConfig;
  const channels = config?.["channels"] as Record<string, Record<string, unknown>> | undefined;
  const botcord = channels?.["botcord"];
  const enabled = botcord?.["enabled"];
  return makeResult(
    "openclaw_config.botcord_enabled",
    inst.id,
    enabled === true,
    true,
    enabled,
    JSON.stringify(botcord ?? {}).slice(0, 300),
  );
}

export function assertCredentialsFileExists(inst: InstanceState, evidence: InstanceEvidence): AssertionResult {
  const config = evidence.openclawConfig;
  const channels = config?.["channels"] as Record<string, Record<string, unknown>> | undefined;
  const botcord = channels?.["botcord"];
  const credentialsFile = botcord?.["credentialsFile"] as string | undefined;

  if (!credentialsFile || credentialsFile.length === 0) {
    return makeResult(
      "openclaw_config.credentials_file_exists",
      inst.id,
      false,
      "credentialsFile set and points to actual file",
      "credentialsFile not set in config",
    );
  }

  if (!evidence.credentialsPath) {
    return makeResult(
      "openclaw_config.credentials_file_exists",
      inst.id,
      false,
      "credentialsFile set and points to actual file",
      `config says ${credentialsFile}, but no credentials file found on disk`,
    );
  }

  // Verify the config path actually points to the file we found.
  // credentialsFile in config is a container path like ~/.botcord/credentials/ag_xxx.json
  // evidence.credentialsPath is a host path like .../instances/openclaw-1/.botcord/credentials/ag_xxx.json
  // Compare by filename to verify they agree on which credential file to use.
  const configFilename = basename(credentialsFile);
  const actualFilename = basename(evidence.credentialsPath);
  const matches = configFilename === actualFilename;

  return makeResult(
    "openclaw_config.credentials_file_exists",
    inst.id,
    matches,
    `credentialsFile points to actual file (${configFilename})`,
    matches
      ? `config: ${credentialsFile} -> found: ${actualFilename}`
      : `config filename: ${configFilename}, actual filename: ${actualFilename} — MISMATCH`,
  );
}

export function assertDeliveryModeSet(inst: InstanceState, evidence: InstanceEvidence): AssertionResult {
  const config = evidence.openclawConfig;
  const channels = config?.["channels"] as Record<string, Record<string, unknown>> | undefined;
  const botcord = channels?.["botcord"];
  const deliveryMode = botcord?.["deliveryMode"] as string | undefined;
  const valid = deliveryMode === "websocket" || deliveryMode === "polling";
  return makeResult(
    "openclaw_config.delivery_mode_set",
    inst.id,
    valid,
    "websocket or polling",
    deliveryMode ?? "not set",
  );
}

export function assertCredentialsValidJson(inst: InstanceState, evidence: InstanceEvidence): AssertionResult {
  const creds = evidence.credentials;
  return makeResult(
    "credentials.valid_json",
    inst.id,
    creds !== null && creds !== undefined && typeof creds === "object",
    "valid JSON object",
    creds ? "valid" : "missing or invalid",
  );
}

export function assertCredentialsHasAgentId(inst: InstanceState, evidence: InstanceEvidence): AssertionResult {
  const creds = evidence.credentials;
  const agentId = creds?.["agentId"] as string | undefined;
  const hasId = !!agentId && agentId.startsWith("ag_");
  return makeResult(
    "credentials.has_agent_id",
    inst.id,
    hasId,
    "agentId starting with ag_",
    agentId ?? "missing",
  );
}

export function assertCredentialsHubMatchesEnv(inst: InstanceState, evidence: InstanceEvidence, env: EnvironmentConfig): AssertionResult {
  const creds = evidence.credentials;
  const hubUrl = creds?.["hubUrl"] as string | undefined;
  // The hub URL in credentials should match the environment's hub base URL
  const matches = !!hubUrl && (
    hubUrl.startsWith(env.hub_base_url) ||
    hubUrl.includes(new URL(env.hub_base_url).hostname)
  );
  return makeResult(
    "credentials.hub_matches_environment",
    inst.id,
    matches,
    env.hub_base_url,
    hubUrl ?? "missing",
  );
}

export async function assertCredentialsPersistAfterRestart(inst: InstanceState, evidence: InstanceEvidence): Promise<AssertionResult> {
  // After restart, check credentials file still exists
  const credDir = resolve(inst.instanceDir, ".botcord", "credentials");
  try {
    const files = await readdir(credDir);
    const jsonFiles = files.filter(f => f.endsWith(".json"));
    return makeResult(
      "restart.credentials_persist",
      inst.id,
      jsonFiles.length > 0,
      "credentials file exists after restart",
      `found ${jsonFiles.length} credential files`,
    );
  } catch {
    return makeResult(
      "restart.credentials_persist",
      inst.id,
      false,
      "credentials file exists after restart",
      "credentials directory not accessible",
    );
  }
}
