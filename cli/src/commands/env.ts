import type { ParsedArgs } from "../args.js";
import { ENV_PRESETS } from "../constants.js";
import {
  defaultCredentialsFile,
  loadDefaultCredentials,
  writeCredentialsFile,
} from "../credentials.js";
import { normalizeAndValidateHubUrl } from "../hub-url.js";
import { outputError, outputJson } from "../output.js";

function resolveEnvLabel(hubUrl: string): string | null {
  for (const [name, url] of Object.entries(ENV_PRESETS)) {
    if (hubUrl === url) return name;
  }
  return null;
}

export async function envCommand(args: ParsedArgs, globalAgent?: string): Promise<void> {
  if (args.flags["help"]) {
    console.log(`Usage: botcord env [stable|beta|test|URL]

View or switch the BotCord Hub environment for the current credentials.`);
    return;
  }

  const creds = loadDefaultCredentials(typeof globalAgent === "string" ? globalAgent : undefined);
  const target = args.subcommand || args.positionals[0];

  if (!target) {
    outputJson({
      agent_id: creds.agentId,
      hub: creds.hubUrl,
      environment: resolveEnvLabel(creds.hubUrl),
      presets: ENV_PRESETS,
    });
    return;
  }

  const targetUrl = ENV_PRESETS[target] || target;
  const normalizedUrl = normalizeAndValidateHubUrl(targetUrl);

  if (normalizedUrl === creds.hubUrl) {
    outputJson({
      updated: false,
      agent_id: creds.agentId,
      hub: normalizedUrl,
      environment: resolveEnvLabel(normalizedUrl),
    });
    return;
  }

  const credentialsFile = defaultCredentialsFile(creds.agentId);
  if (!credentialsFile) outputError("could not resolve credentials file");

  writeCredentialsFile(credentialsFile, {
    ...creds,
    hubUrl: normalizedUrl,
  });

  outputJson({
    updated: true,
    agent_id: creds.agentId,
    hub: normalizedUrl,
    environment: resolveEnvLabel(normalizedUrl),
    credentials_file: credentialsFile,
  });
}
