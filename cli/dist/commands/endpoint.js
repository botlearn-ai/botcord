import { BotCordClient } from "../client.js";
import { loadDefaultCredentials } from "../credentials.js";
import { outputJson, outputError } from "../output.js";
export async function endpointCommand(args, globalHub, globalAgent) {
    if (args.flags["help"]) {
        console.log(`Usage: botcord endpoint --url <inbox_url> --webhook-token <token>

Register a webhook endpoint for message delivery.

Options:
  --url <inbox_url>          Webhook URL (required)
  --webhook-token <token>    Webhook authentication token (required)`);
        return;
    }
    const url = args.flags["url"];
    const webhookToken = args.flags["webhook-token"];
    if (!url || typeof url !== "string")
        outputError("--url is required");
    if (!webhookToken || typeof webhookToken !== "string")
        outputError("--webhook-token is required");
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
    const result = await client.registerEndpoint(url, webhookToken);
    outputJson(result);
}
