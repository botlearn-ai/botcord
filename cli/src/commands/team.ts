import type { ParsedArgs } from "../args.js";
import { addAuthorizationContextToDetail } from "../authorization-context.js";
import { BotCordClient } from "../client.js";
import type { StoredBotCordCredentials } from "../credentials.js";
import { loadDefaultCredentials } from "../credentials.js";
import { normalizeAndValidateHubUrl } from "../hub-url.js";
import { outputError, outputErrorObject, outputJson } from "../output.js";

function optionalString(value: string | boolean | undefined): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalInt(name: string, value: string | boolean | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") outputError(`--${name} requires a number`);
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) outputError(`--${name} requires a number`);
  return parsed;
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
  credentials: StoredBotCordCredentials,
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
      error: detail.code || "team_create_failed",
      status: resp.status,
      ...addAuthorizationContextToDetail(detail, credentials),
    });
  }
  const text = json ? JSON.stringify(json) : await resp.text().catch(() => "");
  outputError(`team create failed (${resp.status}): ${text || resp.statusText}`);
}

export async function teamCommand(
  args: ParsedArgs,
  globalHub?: string,
  globalAgent?: string,
): Promise<void> {
  if (args.flags["help"] || args.subcommand !== "create") {
    console.log(`Usage: botcord team create --goal <goal> [options]

Provision a small Cloud Agent team using the current agent credential.

Options:
  --goal <text>                 Team goal (required)
  --role-count <n>              Number of default roles, 1-5
  --room-name <name>            Room name
  --start-runs <true|false>     Start kickoff runs (default: true)
  --max-wall-time <seconds>     Run budget wall-clock seconds
  --max-tool-calls <n>          Run budget tool-call limit`);
    return;
  }

  const goal = optionalString(args.flags["goal"]);
  if (!goal) outputError("--goal is required");

  const body: Record<string, unknown> = { goal };
  const roleCount = optionalInt("role-count", args.flags["role-count"]);
  if (roleCount !== undefined) body.role_count = roleCount;
  const roomName = optionalString(args.flags["room-name"]);
  if (roomName) body.room_name = roomName;
  const startRuns = optionalBool("start-runs", args.flags["start-runs"]);
  if (startRuns !== undefined) body.start_runs = startRuns;
  const maxWallTime = optionalInt("max-wall-time", args.flags["max-wall-time"]);
  const maxToolCalls = optionalInt("max-tool-calls", args.flags["max-tool-calls"]);
  if (maxWallTime !== undefined || maxToolCalls !== undefined) {
    body.budget = {
      ...(maxWallTime !== undefined ? { max_wall_time_seconds: maxWallTime } : {}),
      ...(maxToolCalls !== undefined ? { max_tool_calls: maxToolCalls } : {}),
    };
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

  outputJson(await appPost(
    hubUrl,
    token,
    "/api/team-orchestration/provision",
    body,
    creds,
  ));
}
