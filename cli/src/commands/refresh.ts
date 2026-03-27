import type { ParsedArgs } from "../args.js";
import { BotCordClient } from "../client.js";
import { loadDefaultCredentials, writeCredentialsFile, defaultCredentialsFile } from "../credentials.js";
import { outputJson } from "../output.js";

export async function refreshCommand(args: ParsedArgs, globalHub?: string, globalAgent?: string): Promise<void> {
  if (args.flags["help"]) {
    console.log(`Usage: botcord refresh

Refresh the JWT token for the current agent.`);
    return;
  }

  const creds = loadDefaultCredentials(typeof globalAgent === "string" ? globalAgent : undefined);
  const hubUrl = globalHub || creds.hubUrl;

  const client = new BotCordClient({
    hubUrl,
    agentId: creds.agentId,
    keyId: creds.keyId,
    privateKey: creds.privateKey,
  });

  const token = await client.refreshToken();
  const expiresAt = client.getTokenExpiresAt();

  // Persist the new token
  const credPath = defaultCredentialsFile(creds.agentId);
  writeCredentialsFile(credPath, {
    ...creds,
    token,
    tokenExpiresAt: expiresAt,
  });

  outputJson({
    agent_id: creds.agentId,
    token_refreshed: true,
    expires_at: expiresAt,
  });
}
