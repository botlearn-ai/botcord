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
           [--reference-type <type>] [--reference-id <id>]
           [--metadata <json>] [--idempotency-key <key>]
  topup --amount <n>               Request a topup
        [--channel <channel>] [--metadata <json>] [--idempotency-key <key>]
  withdraw --amount <n>            Request a withdrawal
           [--fee <minor>] [--destination-type <type>]
           [--destination <json>] [--idempotency-key <key>]`);
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
            const referenceType = typeof args.flags["reference-type"] === "string" ? args.flags["reference-type"] : undefined;
            const referenceId = typeof args.flags["reference-id"] === "string" ? args.flags["reference-id"] : undefined;
            const metadata = typeof args.flags["metadata"] === "string" ? JSON.parse(args.flags["metadata"]) : undefined;
            const idempotencyKey = typeof args.flags["idempotency-key"] === "string" ? args.flags["idempotency-key"] : undefined;
            const result = await client.createTransfer({
                to_agent_id: to,
                amount_minor: amount,
                memo,
                reference_type: referenceType,
                reference_id: referenceId,
                metadata,
                idempotency_key: idempotencyKey,
            });
            outputJson(result);
            break;
        }
        case "topup": {
            const amount = args.flags["amount"];
            if (!amount || typeof amount !== "string")
                outputError("--amount is required");
            const channel = typeof args.flags["channel"] === "string" ? args.flags["channel"] : undefined;
            const metadata = typeof args.flags["metadata"] === "string" ? JSON.parse(args.flags["metadata"]) : undefined;
            const idempotencyKey = typeof args.flags["idempotency-key"] === "string" ? args.flags["idempotency-key"] : undefined;
            const result = await client.createTopup({
                amount_minor: amount,
                channel,
                metadata,
                idempotency_key: idempotencyKey,
            });
            outputJson(result);
            break;
        }
        case "withdraw": {
            const amount = args.flags["amount"];
            if (!amount || typeof amount !== "string")
                outputError("--amount is required");
            const feeminor = typeof args.flags["fee"] === "string" ? args.flags["fee"] : undefined;
            const destinationType = typeof args.flags["destination-type"] === "string" ? args.flags["destination-type"] : undefined;
            const destination = typeof args.flags["destination"] === "string" ? JSON.parse(args.flags["destination"]) : undefined;
            const idempotencyKey = typeof args.flags["idempotency-key"] === "string" ? args.flags["idempotency-key"] : undefined;
            const result = await client.createWithdrawal({
                amount_minor: amount,
                fee_minor: feeminor,
                destination_type: destinationType,
                destination,
                idempotency_key: idempotencyKey,
            });
            outputJson(result);
            break;
        }
        default:
            outputError(`unknown subcommand: ${sub}`);
    }
}
