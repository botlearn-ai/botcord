import type { ParsedArgs } from "../args.js";
import { BotCordClient } from "../client.js";
import { loadDefaultCredentials } from "../credentials.js";
import { normalizeAndValidateHubUrl } from "../hub-url.js";
import { outputError, outputErrorObject, outputJson } from "../output.js";

function optionalString(value: string | boolean | undefined): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalBool(name: string, value: string | boolean | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "boolean") return value;
  const normalized = value.trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "off"].includes(normalized)) return false;
  outputError(`--${name} must be true or false`);
}

async function appPost(
  hubUrl: string,
  token: string,
  path: string,
  body: Record<string, unknown>,
  action: string,
): Promise<unknown> {
  const resp = await fetch(`${hubUrl.replace(/\/+$/, "")}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  });
  if (resp.ok) return await resp.json();

  const json = await resp.json().catch(() => null) as Record<string, unknown> | null;
  const detail = json && typeof json.detail === "object" && json.detail !== null
    ? json.detail as Record<string, unknown>
    : null;
  if (detail) {
    outputErrorObject({
      error: detail.code || `${action}_failed`,
      status: resp.status,
      ...detail,
    });
  }
  const text = json ? JSON.stringify(json) : await resp.text().catch(() => "");
  outputError(`${action} failed (${resp.status}): ${text || resp.statusText}`);
}

export async function botCommand(
  args: ParsedArgs,
  globalHub?: string,
  globalAgent?: string,
): Promise<void> {
  if (args.flags["help"] || args.subcommand !== "create") {
    console.log(`Usage: botcord bot create --name <name> [options]

Create a BotCord bot using the current agent credential.

Options:
  --name <name>                  Bot display name (required)
  --bio <text>                   Bot bio
  --cloud                        Create a cloud-hosted bot (default)
  --daemon <daemon_instance_id>  Create on a local daemon instead of cloud
  --runtime <id>                 Runtime id (required for --daemon)
  --model-profile <id>           Cloud model profile
  --runtime-model <id>           Runtime model id/alias
  --reasoning-effort <value>     Runtime reasoning effort
  --thinking <true|false>        Runtime thinking toggle
  --cwd <path>                   Local daemon working directory
  --openclaw-gateway <name>      OpenClaw gateway selection
  --openclaw-agent <id>          OpenClaw agent selection
  --hermes-profile <name>        Hermes profile selection`);
    return;
  }

  const name = optionalString(args.flags["name"]);
  if (!name) outputError("--name is required");

  const daemonId = optionalString(args.flags["daemon"]);
  if (daemonId && args.flags["cloud"] === true) {
    outputError("--cloud and --daemon cannot be used together");
  }

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
  const token = await client.ensureToken();

  const runtime = optionalString(args.flags["runtime"]);
  const body: Record<string, unknown> = {
    bio: optionalString(args.flags["bio"]),
    runtime,
    runtime_model: optionalString(args.flags["runtime-model"]),
    reasoning_effort: optionalString(args.flags["reasoning-effort"]),
    thinking: optionalBool("thinking", args.flags["thinking"]),
  };
  for (const key of Object.keys(body)) {
    if (body[key] === undefined) delete body[key];
  }

  if (daemonId) {
    if (!runtime) outputError("--runtime is required when --daemon is used");
    body.daemon_instance_id = daemonId;
    body.label = name;
    body.cwd = optionalString(args.flags["cwd"]);
    body.openclaw_gateway = optionalString(args.flags["openclaw-gateway"]);
    body.openclaw_agent = optionalString(args.flags["openclaw-agent"]);
    body.hermes_profile = optionalString(args.flags["hermes-profile"]);
    for (const key of Object.keys(body)) {
      if (body[key] === undefined) delete body[key];
    }
    outputJson(await appPost(hubUrl, token, "/api/users/me/agents/provision", body, "bot_create"));
    return;
  }

  body.name = name;
  body.model_profile = optionalString(args.flags["model-profile"]);
  for (const key of Object.keys(body)) {
    if (body[key] === undefined) delete body[key];
  }
  outputJson(await appPost(hubUrl, token, "/api/cloud-agents", body, "bot_create"));
}
