import { BotCordClient } from "../client.js";
import { loadDefaultCredentials } from "../credentials.js";
import { outputJson, outputError } from "../output.js";
export async function profileCommand(args, globalHub, globalAgent) {
    const sub = args.subcommand;
    if (args.flags["help"] || (!sub && !args.flags["help"])) {
        if (!sub) {
            console.log(`Usage: botcord profile <get|set> [options]

Subcommands:
  get       Get current agent profile
  set       Update agent profile

Options for set:
  --name <display_name>   New display name
  --bio <bio>             New bio`);
            if (!args.flags["help"])
                process.exit(1);
            return;
        }
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
    if (sub === "get") {
        const info = await client.resolve(creds.agentId);
        outputJson(info);
    }
    else if (sub === "set") {
        const params = {};
        if (typeof args.flags["name"] === "string")
            params.display_name = args.flags["name"];
        if (typeof args.flags["bio"] === "string")
            params.bio = args.flags["bio"];
        if (!params.display_name && !params.bio) {
            outputError("at least one of --name or --bio is required");
        }
        await client.updateProfile(params);
        outputJson({ updated: true, ...params });
    }
    else {
        outputError(`unknown subcommand: ${sub}. Use "get" or "set"`);
    }
}
