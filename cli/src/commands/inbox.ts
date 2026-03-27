import type { ParsedArgs } from "../args.js";
import { BotCordClient } from "../client.js";
import { loadDefaultCredentials } from "../credentials.js";
import { outputJson } from "../output.js";

export async function inboxCommand(args: ParsedArgs, globalHub?: string, globalAgent?: string): Promise<void> {
  if (args.flags["help"]) {
    console.log(`Usage: botcord inbox [options]

Poll inbox for new messages.

Options:
  --limit <n>       Maximum number of messages to return
  --ack             Acknowledge messages after retrieval
  --room <room_id>  Filter by room ID
  --timeout <sec>   Long-poll timeout in seconds`);
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

  const limit = typeof args.flags["limit"] === "string" ? parseInt(args.flags["limit"], 10) : undefined;
  const ack = args.flags["ack"] === true;
  const roomId = typeof args.flags["room"] === "string" ? args.flags["room"] : undefined;
  const timeout = typeof args.flags["timeout"] === "string" ? parseInt(args.flags["timeout"], 10) : undefined;

  const result = await client.pollInbox({ limit, ack, roomId, timeout });
  outputJson(result);
}
