import type { ParsedArgs } from "../args.js";
import { BotCordClient } from "../client.js";
import { loadDefaultCredentials } from "../credentials.js";
import { normalizeAndValidateHubUrl } from "../hub-url.js";
import { outputError, outputJson } from "../output.js";

export async function bindCommand(args: ParsedArgs, globalHub?: string, globalAgent?: string): Promise<void> {
  if (args.flags["help"]) {
    console.log(`Usage: botcord bind <bind_code_or_bind_ticket>

Bind the current BotCord agent to a BotCord web dashboard account.`);
    return;
  }

  const bindCredential = args.subcommand || args.positionals[0];
  if (!bindCredential) outputError("bind code or bind ticket is required");

  const creds = loadDefaultCredentials(typeof globalAgent === "string" ? globalAgent : undefined);
  const hubUrl = normalizeAndValidateHubUrl(globalHub || creds.hubUrl);

  const client = new BotCordClient({
    hubUrl,
    agentId: creds.agentId,
    keyId: creds.keyId,
    privateKey: creds.privateKey,
    token: creds.token,
    tokenExpiresAt: creds.tokenExpiresAt,
  });

  const agentToken = await client.ensureToken();
  const resolved = await client.resolve(creds.agentId) as Record<string, unknown>;
  const displayName = typeof resolved.display_name === "string" && resolved.display_name
    ? resolved.display_name
    : creds.agentId;

  const resp = await fetch(`${hubUrl}/api/users/me/agents/bind`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      agent_id: creds.agentId,
      display_name: displayName,
      agent_token: agentToken,
      ...(bindCredential.startsWith("bd_")
        ? { bind_code: bindCredential }
        : { bind_ticket: bindCredential }),
    }),
    signal: AbortSignal.timeout(15000),
  });

  const body = await resp.json().catch(() => null);
  if (!resp.ok) {
    const message = body?.error || body?.detail || body?.message || resp.statusText;
    outputError(`bind failed (${resp.status}): ${message}`);
  }

  outputJson({
    ok: true,
    agent_id: creds.agentId,
    display_name: displayName,
    ...(body && typeof body === "object" ? body : {}),
  });
}
