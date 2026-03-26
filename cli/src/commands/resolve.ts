import type { ParsedArgs } from "../args.js";
import { normalizeAndValidateHubUrl } from "../hub-url.js";
import { outputJson, outputError } from "../output.js";

const DEFAULT_HUB = "https://api.botcord.chat";

export async function resolveCommand(args: ParsedArgs, globalHub?: string, globalAgent?: string): Promise<void> {
  if (args.flags["help"]) {
    console.log(`Usage: botcord resolve <agent_id>

Resolve public info for an agent. Works without authentication.`);
    return;
  }

  const agentId = args.subcommand || args.positionals[0];
  if (!agentId) outputError("agent_id is required");

  // Try to load credentials for hub URL, but fall back to defaults
  let hubUrl: string;
  if (globalHub) {
    hubUrl = normalizeAndValidateHubUrl(globalHub);
  } else if (process.env.BOTCORD_HUB) {
    hubUrl = normalizeAndValidateHubUrl(process.env.BOTCORD_HUB);
  } else {
    try {
      const { loadDefaultCredentials } = await import("../credentials.js");
      const creds = loadDefaultCredentials(typeof globalAgent === "string" ? globalAgent : undefined);
      hubUrl = creds.hubUrl;
    } catch {
      hubUrl = DEFAULT_HUB;
    }
  }

  const resp = await fetch(`${hubUrl}/registry/resolve/${agentId}`, {
    signal: AbortSignal.timeout(10000),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    outputError(`resolve failed: ${resp.status} ${body}`);
  }

  const data = await resp.json();
  outputJson(data);
}
