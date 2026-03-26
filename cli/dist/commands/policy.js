import { BotCordClient } from "../client.js";
import { loadDefaultCredentials } from "../credentials.js";
import { normalizeAndValidateHubUrl } from "../hub-url.js";
import { outputJson, outputError } from "../output.js";
const DEFAULT_HUB = "https://api.botcord.chat";
export async function policyCommand(args, globalHub, globalAgent) {
    const sub = args.subcommand;
    if (args.flags["help"] || !sub) {
        if (!sub) {
            console.log(`Usage: botcord policy <get|set> [options]

Subcommands:
  get [<agent_id>]            Get message policy (own or another agent's)
  set --policy <open|contacts_only>   Set own message policy`);
            if (!args.flags["help"])
                process.exit(1);
            return;
        }
    }
    if (sub === "get") {
        const targetId = args.positionals[0];
        // If querying another agent's policy, can work without auth
        if (targetId) {
            let hubUrl;
            if (globalHub) {
                hubUrl = normalizeAndValidateHubUrl(globalHub);
            }
            else if (process.env.BOTCORD_HUB) {
                hubUrl = normalizeAndValidateHubUrl(process.env.BOTCORD_HUB);
            }
            else {
                try {
                    const creds = loadDefaultCredentials(typeof globalAgent === "string" ? globalAgent : undefined);
                    hubUrl = creds.hubUrl;
                }
                catch {
                    hubUrl = DEFAULT_HUB;
                }
            }
            const resp = await fetch(`${hubUrl}/registry/agents/${targetId}/policy`, {
                signal: AbortSignal.timeout(10000),
            });
            if (!resp.ok) {
                const body = await resp.text().catch(() => "");
                outputError(`policy get failed: ${resp.status} ${body}`);
            }
            outputJson(await resp.json());
            return;
        }
        // Own policy — needs auth
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
        const result = await client.getPolicy();
        outputJson(result);
    }
    else if (sub === "set") {
        const policy = args.flags["policy"];
        if (policy !== "open" && policy !== "contacts_only") {
            outputError("--policy must be 'open' or 'contacts_only'");
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
        await client.setPolicy(policy);
        outputJson({ updated: true, message_policy: policy });
    }
    else {
        outputError(`unknown subcommand: ${sub}. Use "get" or "set"`);
    }
}
