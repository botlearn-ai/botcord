import type { ParsedArgs } from "../args.js";
import {
  loadDefaultCredentials,
  resolveCredentialsFilePath,
  writeCredentialsFile,
} from "../credentials.js";
import { outputError, outputJson } from "../output.js";

export async function exportCommand(args: ParsedArgs, globalAgent?: string): Promise<void> {
  if (args.flags["help"]) {
    console.log(`Usage: botcord export --dest <path>

Export the current BotCord credentials to a file.`);
    return;
  }

  const destination = args.flags["dest"];
  if (!destination || typeof destination !== "string") outputError("--dest is required");

  const creds = loadDefaultCredentials(typeof globalAgent === "string" ? globalAgent : undefined);
  const credentialsFile = writeCredentialsFile(resolveCredentialsFilePath(destination), creds);

  outputJson({
    exported: true,
    agent_id: creds.agentId,
    key_id: creds.keyId,
    hub: creds.hubUrl,
    credentials_file: credentialsFile,
  });
}
