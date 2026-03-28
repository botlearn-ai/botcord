/**
 * Shared BotCord credential reset flow for commands and tools.
 * Generates a new local keypair, redeems a one-time reset code/ticket, and
 * persists the replacement credentials through OpenClaw's config writer.
 */
import { defaultCredentialsFile, type StoredBotCordCredentials, writeCredentialsFile } from "./credentials.js";
import { generateKeypair } from "./crypto.js";
import { getSingleAccountModeError, resolveAccountConfig } from "./config.js";
import { normalizeAndValidateHubUrl } from "./hub-url.js";
import { getBotCordRuntime } from "./runtime.js";

export interface ResetCredentialResult {
  agentId: string;
  displayName: string;
  keyId: string;
  hubUrl: string;
  credentialsFile: string;
}

type ResetCredentialApiResponse = {
  agent_id: string;
  display_name: string;
  key_id: string;
  agent_token: string;
  expires_at: number;
  hub_url?: string | null;
};

function stripInlineCredentials(botcordCfg: Record<string, any>): Record<string, any> {
  const next = { ...botcordCfg };
  delete next.hubUrl;
  delete next.agentId;
  delete next.keyId;
  delete next.privateKey;
  delete next.publicKey;
  return next;
}

function buildNextConfig(config: Record<string, any>, credentialsFile: string): Record<string, any> {
  const currentBotcord = ((config.channels as Record<string, any>)?.botcord ?? {}) as Record<string, any>;
  return {
    ...config,
    channels: {
      ...(config.channels as Record<string, any>),
      botcord: {
        ...stripInlineCredentials(currentBotcord),
        enabled: true,
        credentialsFile,
        deliveryMode: currentBotcord.deliveryMode === "polling" ? "polling" : "websocket",
        notifySession: currentBotcord.notifySession || "botcord:owner:main",
      },
    },
    session: {
      ...(config.session as Record<string, any>),
      dmScope: (config.session as Record<string, any>)?.dmScope || "per-channel-peer",
    },
  };
}

export async function resetCredential(opts: {
  config: Record<string, any>;
  agentId: string;
  resetCodeOrTicket: string;
  hubUrl?: string;
}): Promise<ResetCredentialResult> {
  const { config, agentId, resetCodeOrTicket } = opts;
  const singleAccountError = getSingleAccountModeError(config);
  if (singleAccountError) {
    throw new Error(singleAccountError);
  }
  if (!agentId.startsWith("ag_")) {
    throw new Error("agent_id must start with 'ag_'");
  }
  if (!resetCodeOrTicket.trim()) {
    throw new Error("reset code or reset ticket is required");
  }

  const existingAccount = resolveAccountConfig(config);
  const resolvedHubUrl = normalizeAndValidateHubUrl(
    opts.hubUrl || existingAccount.hubUrl || "",
  );

  const keypair = generateKeypair();
  const payload: Record<string, unknown> = {
    agent_id: agentId,
    pubkey: keypair.pubkeyFormatted,
  };
  if (resetCodeOrTicket.startsWith("rc_")) {
    payload.reset_code = resetCodeOrTicket;
  } else {
    payload.reset_ticket = resetCodeOrTicket;
  }

  const resp = await fetch(`${resolvedHubUrl}/api/users/me/agents/reset-credential`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15000),
  });

  const body = (await resp.json().catch(() => null)) as ResetCredentialApiResponse | { detail?: string; error?: string } | null;
  if (!resp.ok) {
    const message = (body as any)?.detail || (body as any)?.error || resp.statusText;
    throw new Error(`Credential reset failed (${resp.status}): ${message}`);
  }

  const result = body as ResetCredentialApiResponse;
  const finalHubUrl = normalizeAndValidateHubUrl(result.hub_url || resolvedHubUrl);
  const credentials: StoredBotCordCredentials = {
    version: 1,
    hubUrl: finalHubUrl,
    agentId: result.agent_id,
    keyId: result.key_id,
    privateKey: keypair.privateKey,
    publicKey: keypair.publicKey,
    displayName: result.display_name,
    savedAt: new Date().toISOString(),
    token: result.agent_token,
    tokenExpiresAt: result.expires_at,
  };

  const runtime = getBotCordRuntime();
  const credentialsFile = writeCredentialsFile(
    existingAccount.credentialsFile || defaultCredentialsFile(result.agent_id),
    credentials,
  );
  await runtime.config.writeConfigFile(buildNextConfig(config, credentialsFile));

  return {
    agentId: result.agent_id,
    displayName: result.display_name,
    keyId: result.key_id,
    hubUrl: finalHubUrl,
    credentialsFile,
  };
}
