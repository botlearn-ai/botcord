import { BotCordClient } from "../client.js";
import { loadDefaultCredentials } from "../credentials.js";
import { outputJson } from "../output.js";
export async function inboxCommand(args, globalHub, globalAgent) {
    if (args.flags["help"]) {
        console.log(`Usage: botcord inbox [options]

Poll inbox for new messages.

Options:
  --limit <n>       Maximum number of messages to return
  --ack             Acknowledge messages after retrieval
  --room <room_id>  Filter by room ID`);
        return;
    }
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
    const limit = typeof args.flags["limit"] === "string" ? parseInt(args.flags["limit"], 10) : undefined;
    const ack = args.flags["ack"] === true;
    const roomId = typeof args.flags["room"] === "string" ? args.flags["room"] : undefined;
    const result = await client.pollInbox({ limit, ack, roomId });
    outputJson(result);
}
