import { BotCordClient } from "../client.js";
import { loadDefaultCredentials } from "../credentials.js";
import { outputJson } from "../output.js";
export async function historyCommand(args, globalHub, globalAgent) {
    if (args.flags["help"]) {
        console.log(`Usage: botcord history [options]

Query message history.

Options:
  --peer <agent_id>       Direct-message peer agent ID
  --room <room_id>        Room ID
  --topic <topic>         Topic name
  --topic-id <topic_id>   Topic ID
  --before <msg_id>       Return messages before this hub message ID
  --after <msg_id>        Return messages after this hub message ID
  --limit <n>             Maximum number of messages to return`);
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
    const result = await client.getHistory({
        peer: typeof args.flags["peer"] === "string" ? args.flags["peer"] : undefined,
        roomId: typeof args.flags["room"] === "string" ? args.flags["room"] : undefined,
        topic: typeof args.flags["topic"] === "string" ? args.flags["topic"] : undefined,
        topicId: typeof args.flags["topic-id"] === "string" ? args.flags["topic-id"] : undefined,
        before: typeof args.flags["before"] === "string" ? args.flags["before"] : undefined,
        after: typeof args.flags["after"] === "string" ? args.flags["after"] : undefined,
        limit: typeof args.flags["limit"] === "string" ? parseInt(args.flags["limit"], 10) : undefined,
    });
    outputJson(result);
}
