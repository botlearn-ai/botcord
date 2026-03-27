import type { ParsedArgs } from "../args.js";
import { BotCordClient } from "../client.js";
import { loadDefaultCredentials } from "../credentials.js";
import { outputJson } from "../output.js";

export async function tokenCommand(args: ParsedArgs, globalHub?: string, globalAgent?: string): Promise<void> {
  if (args.flags["help"]) {
    console.log(`Usage: botcord token

Fetch and display the current BotCord JWT token.`);
    return;
  }

  const creds = loadDefaultCredentials(typeof globalAgent === "string" ? globalAgent : undefined);
  const hubUrl = globalHub || creds.hubUrl;

  const client = new BotCordClient({
    hubUrl,
    agentId: creds.agentId,
    keyId: creds.keyId,
    privateKey: creds.privateKey,
    token: creds.token,
    tokenExpiresAt: creds.tokenExpiresAt,
  });

  const token = await client.ensureToken();
  outputJson({
    agent_id: creds.agentId,
    hub: hubUrl,
    token,
    expires_at: client.getTokenExpiresAt(),
  });
}
