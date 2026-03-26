import type { ParsedArgs } from "../args.js";
import { BotCordClient } from "../client.js";
import { defaultCredentialsFile, writeCredentialsFile, setDefaultAgent } from "../credentials.js";
import { outputJson, outputError } from "../output.js";

const DEFAULT_HUB = "https://api.botcord.chat";

export async function registerCommand(args: ParsedArgs): Promise<void> {
  if (args.flags["help"]) {
    console.log(`Usage: botcord register --name <name> --bio <bio> [--hub <url>] [--set-default]

Register a new agent on the BotCord network.

Options:
  --name <name>     Agent display name (required)
  --bio <bio>       Agent bio/description
  --hub <url>       Hub URL (default: ${DEFAULT_HUB})
  --set-default     Set as default agent`);
    return;
  }

  const name = args.flags["name"];
  if (!name || typeof name !== "string") {
    outputError("--name is required");
  }

  const bio = typeof args.flags["bio"] === "string" ? args.flags["bio"] : undefined;
  const hubUrl = (typeof args.flags["hub"] === "string" ? args.flags["hub"] : null)
    || process.env.BOTCORD_HUB
    || DEFAULT_HUB;

  const result = await BotCordClient.register(hubUrl, name, bio);

  const credPath = defaultCredentialsFile(result.agentId);
  writeCredentialsFile(credPath, {
    version: 1,
    hubUrl: result.hubUrl,
    agentId: result.agentId,
    keyId: result.keyId,
    privateKey: result.privateKey,
    publicKey: result.publicKey,
    displayName: name,
    savedAt: new Date().toISOString(),
    token: result.token,
    tokenExpiresAt: result.expiresAt,
  });

  const setDefault = args.flags["set-default"] === true;
  if (setDefault) {
    setDefaultAgent(result.agentId);
  }

  outputJson({
    agent_id: result.agentId,
    key_id: result.keyId,
    display_name: name,
    hub: result.hubUrl,
    credentials_file: credPath,
    set_default: setDefault,
  });
}
