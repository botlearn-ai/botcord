import type { ParsedArgs } from "../args.js";
import { BotCordClient } from "../client.js";
import { loadDefaultCredentials } from "../credentials.js";
import { outputError, outputJson } from "../output.js";

export async function responseCommand(args: ParsedArgs, globalHub?: string, globalAgent?: string): Promise<void> {
  if (args.flags.help) {
    console.log("botcord response start|no-reply --run-id <id> --room <id> --messages <id,id>");
    return;
  }
  const action = args.subcommand === "start" ? "start" : args.subcommand === "no-reply" ? "no_reply" : null;
  const runId = args.flags["run-id"];
  const room = args.flags.room;
  const ids = typeof args.flags.messages === "string" ? args.flags.messages.split(",").map((id) => id.trim()).filter(Boolean) : [];
  if (!action || typeof runId !== "string" || typeof room !== "string" || !ids.length) {
    outputError("Use response start|no-reply --run-id <id> --room <id> --messages <id,id>");
  }
  const creds = loadDefaultCredentials(globalAgent);
  const client = new BotCordClient({ ...creds, hubUrl: globalHub || creds.hubUrl });
  outputJson(await client.updateResponseRun({ run_id: runId, room_id: room, action, message_ids: ids }));
}
