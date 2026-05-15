/**
 * BotCord CLI commands for registration and credentials management.
 *
 * Supports:
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
} from "../crypto.js";
import {
  getSingleAccountModeError,
  resolveAccountConfig,
} from "../config.js";
import { getBotCordRuntime } from "../runtime.js";

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
  void opts;
  throw new Error(
    "botcord-register is deprecated. Create agents through the authenticated OpenClaw install/provision flow, or import existing credentials with botcord-import.",
  );
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
    commands: ["botcord-import", "botcord-export"],
  };
}
