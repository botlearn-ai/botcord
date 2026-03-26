import type { ParsedArgs } from "../args.js";
import { BotCordClient } from "../client.js";
import { loadDefaultCredentials } from "../credentials.js";
import { outputJson, outputError } from "../output.js";

export async function contactCommand(args: ParsedArgs, globalHub?: string, globalAgent?: string): Promise<void> {
  const sub = args.subcommand;

  if (args.flags["help"] || !sub) {
    console.log(`Usage: botcord contact <subcommand> [options]

Subcommands:
  list              List all contacts
  remove --id <id>  Remove a contact`);
    if (!sub && !args.flags["help"]) process.exit(1);
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

  switch (sub) {
    case "list": {
      const result = await client.listContacts();
      outputJson(result);
      break;
    }

    case "remove": {
      const id = args.flags["id"];
      if (!id || typeof id !== "string") outputError("--id is required");
      await client.removeContact(id);
      outputJson({ removed: true, agent_id: id });
      break;
    }

    default:
      outputError(`unknown subcommand: ${sub}. Use "list" or "remove"`);
  }
}
