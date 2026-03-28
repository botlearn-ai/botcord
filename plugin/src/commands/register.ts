/**
 * BotCord CLI commands for registration and credentials management.
 *
 * Supports:
 * - `openclaw botcord-register`
 * - `openclaw botcord-import`
 * - `openclaw botcord-export`
 */
import { existsSync } from "node:fs";
import {
  defaultCredentialsFile,
  loadStoredCredentials,
  resolveCredentialsFilePath,
  type StoredBotCordCredentials,
  writeCredentialsFile,
} from "../credentials.js";
import {
  derivePublicKey,
  generateKeypair,
  signChallenge,
} from "../crypto.js";
import {
  getSingleAccountModeError,
  resolveAccountConfig,
} from "../config.js";
import { normalizeAndValidateHubUrl } from "../hub-url.js";
import { getBotCordRuntime } from "../runtime.js";
import { DEFAULT_HUB } from "../constants.js";

interface RegisterResult {
  agentId: string;
  keyId: string;
  displayName: string;
  hub: string;
  credentialsFile: string;
  claimUrl?: string;
}

interface ImportResult {
  agentId: string;
  keyId: string;
  hub: string;
  sourceFile: string;
  credentialsFile: string;
}

interface ExportResult {
  agentId: string;
  keyId: string;
  hub: string;
  sourceFile?: string;
  credentialsFile: string;
}

function buildRegistrationKeypair(config: Record<string, any>, newIdentity: boolean) {
  if (newIdentity) return generateKeypair();

  const existing = resolveAccountConfig(config);
  if (!existing.privateKey) return generateKeypair();

  const publicKey = existing.publicKey || derivePublicKey(existing.privateKey);
  return {
    privateKey: existing.privateKey,
    publicKey,
    pubkeyFormatted: `ed25519:${publicKey}`,
  };
}

function stripInlineCredentials(botcordCfg: Record<string, any>): Record<string, any> {
  const next = { ...botcordCfg };
  delete next.hubUrl;
  delete next.agentId;
  delete next.keyId;
  delete next.privateKey;
  delete next.publicKey;
  return next;
}

function buildNextConfig(
  config: Record<string, any>,
  credentialsFile: string,
): Record<string, any> {
  const currentBotcord = ((config.channels as Record<string, any>)?.botcord ?? {}) as Record<string, any>;
  return {
    ...config,
    channels: {
      ...(config.channels as Record<string, any>),
      botcord: {
        ...stripInlineCredentials(currentBotcord),
        enabled: true,
        credentialsFile,
        deliveryMode:
          currentBotcord.deliveryMode === "polling"
            ? "polling"
            : "websocket",
        notifySession:
          currentBotcord.notifySession ||
          "botcord:owner:main",
      },
    },
    session: {
      ...(config.session as Record<string, any>),
      dmScope:
        (config.session as Record<string, any>)?.dmScope ||
        "per-channel-peer",
    },
  };
}

async function persistCredentials(params: {
  config: Record<string, any>;
  credentials: StoredBotCordCredentials;
  destinationFile?: string;
}): Promise<string> {
  const runtime = getBotCordRuntime();
  const existingAccount = resolveAccountConfig(params.config);
  const credentialsFile = writeCredentialsFile(
    params.destinationFile || existingAccount.credentialsFile || defaultCredentialsFile(params.credentials.agentId),
    params.credentials,
  );
  await runtime.config.writeConfigFile(buildNextConfig(params.config, credentialsFile));
  return credentialsFile;
}

function resolveManagedCredentialsFile(accountConfig: Record<string, any>): string | undefined {
  const credentialsFile = accountConfig.credentialsFile;
  return typeof credentialsFile === "string" && credentialsFile.trim()
    ? resolveCredentialsFilePath(credentialsFile)
    : undefined;
}

function buildExportableCredentials(config: Record<string, any>): {
  credentials: StoredBotCordCredentials;
  sourceFile?: string;
} {
  const existingAccount = resolveAccountConfig(config);
  const sourceFile = resolveManagedCredentialsFile(existingAccount);

  if (sourceFile && !existingAccount.privateKey) {
    throw new Error(`BotCord credentialsFile is configured but could not be loaded: ${sourceFile}`);
  }

  if (!existingAccount.hubUrl || !existingAccount.agentId || !existingAccount.keyId || !existingAccount.privateKey) {
    throw new Error("BotCord is not fully configured (need hubUrl, agentId, keyId, privateKey)");
  }

  let displayName: string | undefined;
  if (sourceFile) {
    try {
      displayName = loadStoredCredentials(sourceFile).displayName;
    } catch {
      displayName = undefined;
    }
  }

  const derivedPublicKey = derivePublicKey(existingAccount.privateKey);

  return {
    sourceFile,
    credentials: {
      version: 1,
      hubUrl: existingAccount.hubUrl,
      agentId: existingAccount.agentId,
      keyId: existingAccount.keyId,
      privateKey: existingAccount.privateKey,
      publicKey: derivedPublicKey,
      displayName,
      savedAt: new Date().toISOString(),
    },
  };
}

export async function registerAgent(opts: {
  name: string;
  bio: string;
  hub: string;
  config: Record<string, any>;
  newIdentity?: boolean;
}): Promise<RegisterResult> {
  const {
    name,
    bio,
    hub,
    config,
    newIdentity = false,
  } = opts;
  const singleAccountError = getSingleAccountModeError(config);
  if (singleAccountError) {
    throw new Error(singleAccountError);
  }

  const existingAccount = resolveAccountConfig(config);
  const managedCredentialsFile = resolveManagedCredentialsFile(existingAccount);
  if (!newIdentity && managedCredentialsFile && !existingAccount.privateKey) {
    throw new Error(
      `BotCord credentialsFile is configured but could not be loaded: ${managedCredentialsFile}`,
    );
  }

  // 1. Reuse the existing keypair unless the caller explicitly requests a new identity.
  const keys = buildRegistrationKeypair(config, newIdentity);
  const normalizedBio = bio.trim() || `${name} on BotCord`;
  const normalizedHub = normalizeAndValidateHubUrl(hub);

  // 2. Register with Hub
  const regResp = await fetch(`${normalizedHub}/registry/agents`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      display_name: name,
      pubkey: keys.pubkeyFormatted,
      bio: normalizedBio,
    }),
  });

  if (!regResp.ok) {
    const body = await regResp.text();
    throw new Error(`Registration failed (${regResp.status}): ${body}`);
  }

  const regData = (await regResp.json()) as {
    agent_id: string;
    key_id: string;
    challenge: string;
  };

  // 3. Sign challenge
  const sig = signChallenge(keys.privateKey, regData.challenge);

  // 4. Verify (challenge-response)
  const verifyResp = await fetch(
    `${normalizedHub}/registry/agents/${regData.agent_id}/verify`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        key_id: regData.key_id,
        challenge: regData.challenge,
        sig,
      }),
    },
  );

  if (!verifyResp.ok) {
    const body = await verifyResp.text();
    throw new Error(`Verification failed (${verifyResp.status}): ${body}`);
  }

  const verifyData = (await verifyResp.json()) as { agent_token: string };

  // 5. Fetch claim URL (best-effort)
  let claimUrl: string | undefined;
  try {
    const claimResp = await fetch(
      `${normalizedHub}/registry/agents/${regData.agent_id}/claim-link`,
      {
        headers: { Authorization: `Bearer ${verifyData.agent_token}` },
      },
    );
    if (claimResp.ok) {
      const claimData = (await claimResp.json()) as { claim_url: string };
      claimUrl = claimData.claim_url;
    }
  } catch {
    // Best-effort — claim URL fetch failure should not block registration.
  }

  // 6. Write credentials via OpenClaw's config API
  const credentialsFile = await persistCredentials({
    config,
    credentials: {
      version: 1,
      hubUrl: normalizedHub,
      agentId: regData.agent_id,
      keyId: regData.key_id,
      privateKey: keys.privateKey,
      publicKey: keys.publicKey,
      displayName: name,
      savedAt: new Date().toISOString(),
    },
  });

  return {
    agentId: regData.agent_id,
    keyId: regData.key_id,
    displayName: name,
    hub: normalizedHub,
    credentialsFile,
    claimUrl,
  };
}

export async function importAgentCredentials(opts: {
  file: string;
  config: Record<string, any>;
  destinationFile?: string;
}): Promise<ImportResult> {
  const {
    file,
    config,
    destinationFile,
  } = opts;
  const singleAccountError = getSingleAccountModeError(config);
  if (singleAccountError) {
    throw new Error(singleAccountError);
  }

  const sourceFile = resolveCredentialsFilePath(file);
  const credentials = loadStoredCredentials(sourceFile);
  const credentialsFile = await persistCredentials({
    config,
    credentials,
    destinationFile,
  });

  return {
    agentId: credentials.agentId,
    keyId: credentials.keyId,
    hub: credentials.hubUrl,
    sourceFile,
    credentialsFile,
  };
}

export async function exportAgentCredentials(opts: {
  config: Record<string, any>;
  destinationFile: string;
  force?: boolean;
}): Promise<ExportResult> {
  const {
    config,
    destinationFile,
    force = false,
  } = opts;
  const singleAccountError = getSingleAccountModeError(config);
  if (singleAccountError) {
    throw new Error(singleAccountError);
  }

  const resolvedDestinationFile = resolveCredentialsFilePath(destinationFile);
  if (!force && existsSync(resolvedDestinationFile)) {
    throw new Error(
      `Destination credentials file already exists: ${resolvedDestinationFile} (pass --force to overwrite)`,
    );
  }

  const { credentials, sourceFile } = buildExportableCredentials(config);
  const credentialsFile = writeCredentialsFile(resolvedDestinationFile, credentials);

  return {
    agentId: credentials.agentId,
    keyId: credentials.keyId,
    hub: credentials.hubUrl,
    sourceFile,
    credentialsFile,
  };
}

export function createRegisterCli() {
  return {
    setup: (ctx: any) => {
      ctx.program
        .command("botcord-register")
        .description("Register a new BotCord agent and configure the plugin")
        .requiredOption("--name <name>", "Agent display name")
        .option("--bio <bio>", "Agent bio/description", "")
        .option("--hub <url>", "Hub URL", DEFAULT_HUB)
        .option("--new-identity", "Generate a fresh keypair instead of reusing existing BotCord credentials", false)
        .action(async (options: { name: string; bio: string; hub: string; newIdentity?: boolean }) => {
          try {
            const result = await registerAgent({
              ...options,
              config: ctx.config,
            });
            ctx.logger.info(`Agent registered successfully!`);
            ctx.logger.info(`  Agent ID:     ${result.agentId}`);
            ctx.logger.info(`  Key ID:       ${result.keyId}`);
            ctx.logger.info(`  Display name: ${result.displayName}`);
            ctx.logger.info(`  Hub:          ${result.hub}`);
            ctx.logger.info(`  Credentials:  ${result.credentialsFile}`);
            if (result.claimUrl) {
              ctx.logger.info(`  Claim URL:    ${result.claimUrl}`);
            }
            ctx.logger.info(``);
            ctx.logger.info(`Restart OpenClaw to activate: openclaw gateway restart`);
          } catch (err: any) {
            ctx.logger.error(`Registration failed: ${err.message}`);
            throw err;
          }
        });
      ctx.program
        .command("botcord-import")
        .alias("botcord_import")
        .description("Import existing BotCord credentials from a file and configure the plugin")
        .requiredOption("--file <path>", "Path to an existing BotCord credentials JSON file")
        .option("--dest <path>", "Destination path for the managed credentials file")
        .action(async (options: { file: string; dest?: string }) => {
          try {
            const result = await importAgentCredentials({
              file: options.file,
              destinationFile: options.dest,
              config: ctx.config,
            });
            ctx.logger.info("BotCord credentials imported successfully!");
            ctx.logger.info(`  Agent ID:     ${result.agentId}`);
            ctx.logger.info(`  Key ID:       ${result.keyId}`);
            ctx.logger.info(`  Hub:          ${result.hub}`);
            ctx.logger.info(`  Source:       ${result.sourceFile}`);
            ctx.logger.info(`  Credentials:  ${result.credentialsFile}`);
            ctx.logger.info("");
            ctx.logger.info("Restart OpenClaw to activate: openclaw gateway restart");
          } catch (err: any) {
            ctx.logger.error(`Import failed: ${err.message}`);
            throw err;
          }
        });
      ctx.program
        .command("botcord-export")
        .alias("botcord_export")
        .description("Export the active BotCord credentials to a file")
        .requiredOption("--dest <path>", "Destination path for the exported BotCord credentials JSON file")
        .option("--force", "Overwrite the destination file if it already exists", false)
        .action(async (options: { dest: string; force?: boolean }) => {
          try {
            const result = await exportAgentCredentials({
              config: ctx.config,
              destinationFile: options.dest,
              force: options.force,
            });
            ctx.logger.info("BotCord credentials exported successfully!");
            ctx.logger.info(`  Agent ID:     ${result.agentId}`);
            ctx.logger.info(`  Key ID:       ${result.keyId}`);
            ctx.logger.info(`  Hub:          ${result.hub}`);
            if (result.sourceFile) {
              ctx.logger.info(`  Source:       ${result.sourceFile}`);
            } else {
              ctx.logger.info("  Source:       inline config");
            }
            ctx.logger.info(`  Exported to:  ${result.credentialsFile}`);
          } catch (err: any) {
            ctx.logger.error(`Export failed: ${err.message}`);
            throw err;
          }
        });
    },
    commands: ["botcord-register", "botcord-import", "botcord-export"],
  };
}
