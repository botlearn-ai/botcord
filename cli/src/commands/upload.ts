import path from "node:path";
import type { ParsedArgs } from "../args.js";
import { BotCordClient } from "../client.js";
import { loadDefaultCredentials } from "../credentials.js";
import { outputError, outputJson } from "../output.js";

export async function uploadCommand(args: ParsedArgs, globalHub?: string, globalAgent?: string): Promise<void> {
  if (args.flags["help"]) {
    console.log(`Usage: botcord upload --file <path> [--file <path> ...]

Upload one or more local files to the BotCord Hub and return reusable URLs.`);
    return;
  }

  const rawArgv = process.argv.slice(2);
  const files: string[] = [];
  for (let i = 0; i < rawArgv.length; i++) {
    if (rawArgv[i] === "--file" && rawArgv[i + 1]) {
      files.push(rawArgv[i + 1]);
      i++;
    } else if (rawArgv[i].startsWith("--file=")) {
      files.push(rawArgv[i].slice(7));
    }
  }

  if (files.length === 0) outputError("at least one --file is required");

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

  const uploads = [];
  for (const filePath of files) {
    const uploaded = await client.uploadFile(filePath, path.basename(filePath));
    uploads.push(uploaded);
  }

  outputJson({ files: uploads });
}
