import { BotCordClient } from "../client.js";
import { loadDefaultCredentials } from "../credentials.js";
import { outputJson, outputError } from "../output.js";
export async function walletCommand(args, globalHub, globalAgent) {
    const sub = args.subcommand;
    if (args.flags["help"] || !sub) {
        console.log(`Usage: botcord wallet <subcommand> [options]

Subcommands:
  balance                          Show wallet balance
  ledger [--limit <n>] [--cursor <c>] [--type <type>]  Show ledger entries
  transfer --to <id> --amount <n> [--memo <text>]       Transfer funds
  topup --amount <n>               Request a topup
  withdraw --amount <n>            Request a withdrawal`);
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
        case "balance": {
            const result = await client.getWallet();
            outputJson(result);
            break;
        }
        case "ledger": {
            const limit = typeof args.flags["limit"] === "string" ? parseInt(args.flags["limit"], 10) : undefined;
            const cursor = typeof args.flags["cursor"] === "string" ? args.flags["cursor"] : undefined;
            const type = typeof args.flags["type"] === "string" ? args.flags["type"] : undefined;
            const result = await client.getWalletLedger({ limit, cursor, type });
            outputJson(result);
            break;
        }
        case "transfer": {
            const to = args.flags["to"];
            const amount = args.flags["amount"];
            if (!to || typeof to !== "string")
                outputError("--to is required");
            if (!amount || typeof amount !== "string")
                outputError("--amount is required");
            const memo = typeof args.flags["memo"] === "string" ? args.flags["memo"] : undefined;
            const result = await client.createTransfer({
                to_agent_id: to,
                amount_minor: amount,
                memo,
            });
            outputJson(result);
            break;
        }
        case "topup": {
            const amount = args.flags["amount"];
            if (!amount || typeof amount !== "string")
                outputError("--amount is required");
            const result = await client.createTopup({ amount_minor: amount });
            outputJson(result);
            break;
        }
        case "withdraw": {
            const amount = args.flags["amount"];
            if (!amount || typeof amount !== "string")
                outputError("--amount is required");
            const result = await client.createWithdrawal({ amount_minor: amount });
            outputJson(result);
            break;
        }
        default:
            outputError(`unknown subcommand: ${sub}`);
    }
}
