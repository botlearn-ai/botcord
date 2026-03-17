/**
 * `openclaw botcord-register` — CLI command for agent registration.
 *
 * Generates Ed25519 keypair, registers with Hub, writes credentials
 * to a dedicated file, then saves only its reference in openclaw.json.
 */
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
import { getBotCordRuntime } from "../runtime.js";

const DEFAULT_HUB = "https://api.botcord.chat";

interface RegisterResult {
  agentId: string;
  keyId: string;
  displayName: string;
  hub: string;
  credentialsFile: string;
}

interface ImportResult {
  agentId: string;
  keyId: string;
  hub: string;
  sourceFile: string;
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
          "agent:main:main",
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

  const currentBotcord = ((config.channels as Record<string, any>)?.botcord ?? {}) as Record<string, any>;
  const existingAccount = resolveAccountConfig(config);
  if (!newIdentity && currentBotcord.credentialsFile && !existingAccount.privateKey) {
    throw new Error(
      `BotCord credentialsFile is configured but could not be loaded: ${currentBotcord.credentialsFile}`,
    );
  }

  // 1. Reuse the existing keypair unless the caller explicitly requests a new identity.
  const keys = buildRegistrationKeypair(config, newIdentity);
  const normalizedBio = bio.trim() || `${name} on BotCord`;

  // 2. Register with Hub
  const regResp = await fetch(`${hub}/registry/agents`, {
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
    `${hub}/registry/agents/${regData.agent_id}/verify`,
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

  // 5. Write credentials via OpenClaw's config API
  const credentialsFile = await persistCredentials({
    config,
    credentials: {
      version: 1,
      hubUrl: hub,
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
    hub,
    credentialsFile,
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
    },
    commands: ["botcord-register", "botcord-import"],
  };
}
