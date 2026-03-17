/**
 * `openclaw botcord-register` — CLI command for agent registration.
 *
 * Generates Ed25519 keypair, registers with Hub, writes credentials
 * to openclaw.json via OpenClaw's writeConfigFile API.
 */
import { generateKeypair, signChallenge } from "../crypto.js";
import { getSingleAccountModeError } from "../config.js";
import { getBotCordRuntime } from "../runtime.js";

const DEFAULT_HUB = "https://api.botcord.chat";

interface RegisterResult {
  agentId: string;
  keyId: string;
  displayName: string;
  hub: string;
}

async function registerAgent(opts: {
  name: string;
  bio: string;
  hub: string;
  config: Record<string, any>;
}): Promise<RegisterResult> {
  const { name, bio, hub, config } = opts;
  const singleAccountError = getSingleAccountModeError(config);
  if (singleAccountError) {
    throw new Error(singleAccountError);
  }

  // 1. Generate keypair
  const keys = generateKeypair();

  // 2. Register with Hub
  const regResp = await fetch(`${hub}/registry/agents`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      display_name: name,
      pubkey: keys.pubkeyFormatted,
      bio,
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
  const runtime = getBotCordRuntime();

  const nextConfig = {
    ...config,
    channels: {
      ...(config.channels as Record<string, any>),
      botcord: {
        ...(config.channels as Record<string, any>)?.botcord,
        enabled: true,
        hubUrl: hub,
        agentId: regData.agent_id,
        keyId: regData.key_id,
        privateKey: keys.privateKey,
        publicKey: keys.publicKey,
        deliveryMode:
          (config.channels as Record<string, any>)?.botcord?.deliveryMode === "polling"
            ? "polling"
            : "websocket",
        notifySession:
          (config.channels as Record<string, any>)?.botcord?.notifySession ||
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

  await runtime.config.writeConfigFile(nextConfig);

  return {
    agentId: regData.agent_id,
    keyId: regData.key_id,
    displayName: name,
    hub,
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
        .action(async (options: { name: string; bio: string; hub: string }) => {
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
            ctx.logger.info(``);
            ctx.logger.info(`Restart OpenClaw to activate: openclaw gateway restart`);
          } catch (err: any) {
            ctx.logger.error(`Registration failed: ${err.message}`);
            throw err;
          }
        });
    },
    commands: ["botcord-register"],
  };
}
