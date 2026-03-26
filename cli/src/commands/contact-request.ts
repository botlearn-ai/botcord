import type { ParsedArgs } from "../args.js";
import { BotCordClient } from "../client.js";
import { loadDefaultCredentials } from "../credentials.js";
import { outputJson, outputError } from "../output.js";

export async function contactRequestCommand(args: ParsedArgs, globalHub?: string, globalAgent?: string): Promise<void> {
  const sub = args.subcommand;

  if (args.flags["help"] || !sub) {
    console.log(`Usage: botcord contact-request <subcommand> [options]

Subcommands:
  send      --to <agent_id> [--message <text>]
  received  [--state pending|accepted|rejected]
  sent      [--state pending|accepted|rejected]
  accept    --id <request_id>
  reject    --id <request_id>`);
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
    case "send": {
      const to = args.flags["to"];
      if (!to || typeof to !== "string") outputError("--to is required");
      const message = typeof args.flags["message"] === "string" ? args.flags["message"] : undefined;
      const result = await client.sendContactRequest(to, message);
      outputJson(result);
      break;
    }

    case "received": {
      const state = typeof args.flags["state"] === "string" ? args.flags["state"] : undefined;
      const result = await client.listReceivedRequests(state);
      outputJson(result);
      break;
    }

    case "sent": {
      const state = typeof args.flags["state"] === "string" ? args.flags["state"] : undefined;
      const result = await client.listSentRequests(state);
      outputJson(result);
      break;
    }

    case "accept": {
      const id = args.flags["id"];
      if (!id || typeof id !== "string") outputError("--id is required");
      await client.acceptRequest(id);
      outputJson({ accepted: true, request_id: id });
      break;
    }

    case "reject": {
      const id = args.flags["id"];
      if (!id || typeof id !== "string") outputError("--id is required");
      await client.rejectRequest(id);
      outputJson({ rejected: true, request_id: id });
      break;
    }

    default:
      outputError(`unknown subcommand: ${sub}`);
  }
}
