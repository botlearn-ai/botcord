import type { ParsedArgs } from "../args.js";
import {
  defaultCredentialsFile,
  loadStoredCredentials,
  resolveCredentialsFilePath,
  setDefaultAgent,
  writeCredentialsFile,
} from "../credentials.js";
import { outputError, outputJson } from "../output.js";

export async function importCommand(args: ParsedArgs): Promise<void> {
  if (args.flags["help"]) {
    console.log(`Usage: botcord import --file <path> [--dest <path>] [--set-default]

Import an existing BotCord credentials file into the managed credentials directory.`);
    return;
  }

  const sourceFile = args.flags["file"];
  if (!sourceFile || typeof sourceFile !== "string") outputError("--file is required");

  const credentials = loadStoredCredentials(sourceFile);
  const destination = typeof args.flags["dest"] === "string"
    ? resolveCredentialsFilePath(args.flags["dest"])
    : defaultCredentialsFile(credentials.agentId);

  const credentialsFile = writeCredentialsFile(destination, credentials);
  const setDefault = args.flags["set-default"] === true;
  if (setDefault) {
    setDefaultAgent(credentials.agentId);
  }

  outputJson({
    imported: true,
    agent_id: credentials.agentId,
    key_id: credentials.keyId,
    hub: credentials.hubUrl,
    source_file: resolveCredentialsFilePath(sourceFile),
    credentials_file: credentialsFile,
    set_default: setDefault,
  });
}
