import type { ParsedArgs } from "../args.js";
import { BotCordClient } from "../client.js";
import { loadDefaultCredentials } from "../credentials.js";
import { outputJson, outputError } from "../output.js";
import { normalizeAndValidateHubUrl } from "../hub-url.js";

const DEFAULT_MESSAGE = "【BotCord 自主任务】执行本轮工作目标。";

type AgentScheduleSpec =
  | { kind: "every"; every_ms: number }
  | { kind: "calendar"; frequency: "daily"; time: string; timezone: string }
  | { kind: "calendar"; frequency: "weekly"; time: string; timezone: string; weekdays: number[] };

type SchedulePatchBody = {
  name?: string;
  enabled?: boolean;
  schedule?: AgentScheduleSpec;
  payload?: { kind: "agent_turn"; message: string };
};

function parsePositiveInt(value: unknown, flag: string): number {
  if (typeof value !== "string" || value.trim() === "") outputError(`${flag} is required`);
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) outputError(`${flag} must be a positive integer`);
  return parsed;
}

function parseBoolean(value: unknown, defaultValue: boolean): boolean {
  if (value === undefined) return defaultValue;
  if (value === true) return true;
  if (typeof value !== "string") outputError("--enabled must be true or false");
  if (value === "true") return true;
  if (value === "false") return false;
  outputError("--enabled must be true or false");
}

function parseWeekdays(value: unknown): number[] {
  if (typeof value !== "string" || value.trim() === "") outputError("--weekdays is required for weekly schedules");
  const weekdays = value.split(",").map((item) => Number.parseInt(item.trim(), 10));
  if (weekdays.some((day) => !Number.isInteger(day) || day < 0 || day > 6)) {
    outputError("--weekdays must be comma-separated integers from 0 to 6, Monday=0");
  }
  return [...new Set(weekdays)].sort((a, b) => a - b);
}

function buildSchedule(args: ParsedArgs): AgentScheduleSpec {
  const everyMinutes = args.flags["every-minutes"];
  const everyMs = args.flags["every-ms"];
  const frequency = args.flags["frequency"];
  const time = args.flags["time"];
  const timezone = typeof args.flags["timezone"] === "string" ? args.flags["timezone"] : "UTC";

  if (everyMinutes !== undefined || everyMs !== undefined) {
    if (frequency !== undefined || time !== undefined) {
      outputError("use either --every-minutes/--every-ms or --frequency/--time, not both");
    }
    const intervalMs = everyMs !== undefined
      ? parsePositiveInt(everyMs, "--every-ms")
      : parsePositiveInt(everyMinutes, "--every-minutes") * 60 * 1000;
    return { kind: "every", every_ms: intervalMs };
  }

  if (frequency !== "daily" && frequency !== "weekly") {
    outputError("--frequency must be daily or weekly when interval flags are not used");
  }
  if (typeof time !== "string" || !/^\d{2}:\d{2}$/.test(time)) {
    outputError("--time must be HH:MM");
  }
  if (frequency === "daily") {
    return { kind: "calendar", frequency, time, timezone };
  }
  return { kind: "calendar", frequency, time, timezone, weekdays: parseWeekdays(args.flags["weekdays"]) };
}

async function scheduleRequest(
  client: BotCordClient,
  hubUrl: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<unknown> {
  const token = await client.ensureToken();
  const resp = await fetch(`${hubUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`BotCord ${path} failed: ${resp.status} ${text}`);
  }
  if (resp.status === 204) return null;
  const text = await resp.text();
  return text ? JSON.parse(text) : null;
}

export async function scheduleCommand(args: ParsedArgs, globalHub?: string, globalAgent?: string): Promise<void> {
  const sub = args.subcommand;

  if (args.flags["help"] || !sub) {
    console.log(`Usage: botcord schedule <subcommand> [options]

Subcommands:
  list                                      List proactive schedules
  add --name <name> (--every-minutes <n> | --every-ms <n> |
      --frequency daily|weekly --time HH:MM [--timezone TZ] [--weekdays 0,2])
                                            Create a schedule
  edit --id <schedule_id> [--name <name>] [--message <text>]
      [--enabled true|false] [schedule options]
                                            Edit a schedule
  pause --id <schedule_id>                  Pause a schedule
  resume --id <schedule_id>                 Resume a schedule
  delete --id <schedule_id>                 Delete a schedule
  run --id <schedule_id>                    Run a schedule now
  runs --id <schedule_id>                   List recent runs

Schedule options:
  --every-minutes <n>                       Interval in minutes, minimum 5
  --every-ms <n>                            Interval in milliseconds, minimum 300000
  --frequency daily|weekly --time HH:MM     Calendar schedule
  --timezone <tz>                           IANA timezone, default UTC
  --weekdays <0,2>                          Weekly only; Monday=0, Sunday=6
  --message <text>                          Proactive turn message`);
    if (!sub && !args.flags["help"]) process.exit(1);
    return;
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

  switch (sub) {
    case "list": {
      outputJson(await scheduleRequest(client, hubUrl, "GET", "/hub/schedules"));
      break;
    }
    case "add": {
      const name = args.flags["name"];
      if (typeof name !== "string" || !name.trim()) outputError("--name is required");
      const message = typeof args.flags["message"] === "string" ? args.flags["message"] : DEFAULT_MESSAGE;
      const result = await scheduleRequest(client, hubUrl, "POST", "/hub/schedules", {
        name,
        enabled: parseBoolean(args.flags["enabled"], true),
        schedule: buildSchedule(args),
        payload: { kind: "agent_turn", message },
      });
      outputJson(result);
      break;
    }
    case "edit": {
      const id = args.flags["id"];
      if (typeof id !== "string" || !id) outputError("--id is required");
      const body: SchedulePatchBody = {};
      if (typeof args.flags["name"] === "string") body.name = args.flags["name"];
      if (args.flags["enabled"] !== undefined) body.enabled = parseBoolean(args.flags["enabled"], true);
      if (typeof args.flags["message"] === "string") {
        body.payload = { kind: "agent_turn", message: args.flags["message"] };
      }
      if (
        args.flags["every-minutes"] !== undefined ||
        args.flags["every-ms"] !== undefined ||
        args.flags["frequency"] !== undefined ||
        args.flags["time"] !== undefined
      ) {
        body.schedule = buildSchedule(args);
      }
      if (Object.keys(body).length === 0) outputError("nothing to edit");
      outputJson(await scheduleRequest(client, hubUrl, "PATCH", `/hub/schedules/${encodeURIComponent(id)}`, body));
      break;
    }
    case "pause":
    case "resume": {
      const id = args.flags["id"];
      if (typeof id !== "string" || !id) outputError("--id is required");
      outputJson(await scheduleRequest(
        client,
        hubUrl,
        "PATCH",
        `/hub/schedules/${encodeURIComponent(id)}`,
        { enabled: sub === "resume" },
      ));
      break;
    }
    case "delete": {
      const id = args.flags["id"];
      if (typeof id !== "string" || !id) outputError("--id is required");
      await scheduleRequest(client, hubUrl, "DELETE", `/hub/schedules/${encodeURIComponent(id)}`);
      outputJson({ deleted: true, id });
      break;
    }
    case "run": {
      const id = args.flags["id"];
      if (typeof id !== "string" || !id) outputError("--id is required");
      outputJson(await scheduleRequest(client, hubUrl, "POST", `/hub/schedules/${encodeURIComponent(id)}/run`));
      break;
    }
    case "runs": {
      const id = args.flags["id"];
      if (typeof id !== "string" || !id) outputError("--id is required");
      outputJson(await scheduleRequest(client, hubUrl, "GET", `/hub/schedules/${encodeURIComponent(id)}/runs`));
      break;
    }
    default:
      outputError(`unknown subcommand: ${sub}`);
  }
}
