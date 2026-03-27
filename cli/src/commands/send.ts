import path from "node:path";
import type { ParsedArgs } from "../args.js";
import { BotCordClient } from "../client.js";
import { loadDefaultCredentials } from "../credentials.js";
import { outputJson, outputError } from "../output.js";
import type { MessageAttachment } from "../types.js";

export async function sendCommand(args: ParsedArgs, globalHub?: string, globalAgent?: string): Promise<void> {
  if (args.flags["help"]) {
    console.log(`Usage: botcord send --to <id> --text <msg> [options]

Send a signed message to an agent or room.

Options:
  --to <id>           Recipient agent or room ID (required)
  --text <msg>        Message text (required)
  --type <type>       Message type: message, result, or error (default: message)
  --reply-to <id>     Reply to a specific message ID
  --topic <topic>     Topic name
  --goal <goal>       Goal description
  --ttl <sec>         Message TTL in seconds (default: 3600)
  --file <path>       Attach a file (can be repeated)
  --mention <id>      Mention an agent or @all (can be repeated)`);
    return;
  }

  const to = args.flags["to"];
  const text = args.flags["text"];
  if (!to || typeof to !== "string") outputError("--to is required");
  if (!text || typeof text !== "string") outputError("--text is required");

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

  // Collect --file flags (may appear multiple times in positionals/raw argv)
  const files: string[] = [];
  const rawArgv = process.argv.slice(2);
  for (let i = 0; i < rawArgv.length; i++) {
    if (rawArgv[i] === "--file" && rawArgv[i + 1]) {
      files.push(rawArgv[i + 1]);
      i++;
    } else if (rawArgv[i].startsWith("--file=")) {
      files.push(rawArgv[i].slice(7));
    }
  }

  // Collect --mention flags
  const mentions: string[] = [];
  for (let i = 0; i < rawArgv.length; i++) {
    if (rawArgv[i] === "--mention" && rawArgv[i + 1]) {
      mentions.push(rawArgv[i + 1]);
      i++;
    } else if (rawArgv[i].startsWith("--mention=")) {
      mentions.push(rawArgv[i].slice(10));
    }
  }

  // Upload files
  const attachments: MessageAttachment[] = [];
  for (const filePath of files) {
    const filename = path.basename(filePath);
    const uploaded = await client.uploadFile(filePath, filename);
    attachments.push({
      filename: uploaded.original_filename,
      url: uploaded.url,
      content_type: uploaded.content_type,
      size_bytes: uploaded.size_bytes,
    });
  }

  const replyTo = typeof args.flags["reply-to"] === "string" ? args.flags["reply-to"] : undefined;
  const topic = typeof args.flags["topic"] === "string" ? args.flags["topic"] : undefined;
  const goal = typeof args.flags["goal"] === "string" ? args.flags["goal"] : undefined;
  const ttl = typeof args.flags["ttl"] === "string" ? parseInt(args.flags["ttl"], 10) : undefined;
  const msgType = typeof args.flags["type"] === "string" ? args.flags["type"] : "message";

  let result;
  if (msgType === "result" || msgType === "error") {
    result = await client.sendTypedMessage(to, msgType, text, {
      replyTo,
      topic,
      attachments: attachments.length > 0 ? attachments : undefined,
    });
  } else {
    result = await client.sendMessage(to, text, {
      replyTo,
      topic,
      goal,
      ttlSec: ttl,
      attachments: attachments.length > 0 ? attachments : undefined,
      mentions: mentions.length > 0 ? mentions : undefined,
    });
  }

  outputJson(result);
}
