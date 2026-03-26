import { BotCordClient } from "../client.js";
import { loadDefaultCredentials } from "../credentials.js";
import { outputJson, outputError } from "../output.js";
export async function blockCommand(args, globalHub, globalAgent) {
    const sub = args.subcommand;
    if (args.flags["help"] || !sub) {
        console.log(`Usage: botcord block <subcommand> [options]

Subcommands:
  add    --id <agent_id>    Block an agent
  list                      List blocked agents
  remove --id <agent_id>    Unblock an agent`);
        if (!sub && !args.flags["help"])
            process.exit(1);
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
    switch (sub) {
        case "add": {
            const id = args.flags["id"];
            if (!id || typeof id !== "string")
                outputError("--id is required");
            await client.blockAgent(id);
            outputJson({ blocked: true, agent_id: id });
            break;
        }
        case "list": {
            const result = await client.listBlocks();
            outputJson(result);
            break;
        }
        case "remove": {
            const id = args.flags["id"];
            if (!id || typeof id !== "string")
                outputError("--id is required");
            await client.unblockAgent(id);
            outputJson({ unblocked: true, agent_id: id });
            break;
        }
        default:
            outputError(`unknown subcommand: ${sub}. Use "add", "list", or "remove"`);
    }
}
