import type { ParsedArgs } from "../args.js";
import { BotCordClient } from "../client.js";
import { loadDefaultCredentials } from "../credentials.js";
import { outputJson, outputError } from "../output.js";

export async function subscriptionCommand(args: ParsedArgs, globalHub?: string, globalAgent?: string): Promise<void> {
  const sub = args.subcommand;

  if (args.flags["help"] || !sub) {
    console.log(`Usage: botcord subscription <subcommand> [options]

Subcommands:
  create-product    Create a subscription product
                      --name <name> --amount <minor> --interval <week|month>
                      [--description <text>] [--asset-code <code>]
  list-products     List your own subscription products
  list-all-products List all available subscription products
  archive-product   Archive a subscription product --id <product_id>
  subscribe         Subscribe to a product --product <product_id>
                      [--idempotency-key <key>]
  list              List your active subscriptions
  subscribers       List subscribers of a product --product <product_id>
  cancel            Cancel a subscription --id <subscription_id>`);
    if (!sub && !args.flags["help"]) process.exit(1);
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
    case "create-product": {
      const name = args.flags["name"];
      const amount = args.flags["amount"];
      const interval = args.flags["interval"];
      if (!name || typeof name !== "string") outputError("--name is required");
      if (!amount || typeof amount !== "string") outputError("--amount is required");
      if (interval !== "week" && interval !== "month") outputError("--interval must be 'week' or 'month'");
      const description = typeof args.flags["description"] === "string" ? args.flags["description"] : undefined;
      const assetCode = typeof args.flags["asset-code"] === "string" ? args.flags["asset-code"] : undefined;
      const result = await client.createSubscriptionProduct({
        name,
        amount_minor: amount,
        billing_interval: interval,
        description,
        asset_code: assetCode,
      });
      outputJson(result);
      break;
    }

    case "list-products": {
      const result = await client.listMySubscriptionProducts();
      outputJson(result);
      break;
    }

    case "list-all-products": {
      const result = await client.listSubscriptionProducts();
      outputJson(result);
      break;
    }

    case "archive-product": {
      const id = args.flags["id"];
      if (!id || typeof id !== "string") outputError("--id is required");
      const result = await client.archiveSubscriptionProduct(id);
      outputJson(result);
      break;
    }

    case "subscribe": {
      const productId = args.flags["product"];
      if (!productId || typeof productId !== "string") outputError("--product is required");
      const idempotencyKey = typeof args.flags["idempotency-key"] === "string" ? args.flags["idempotency-key"] : undefined;
      const result = await client.subscribeToProduct(productId, idempotencyKey);
      outputJson(result);
      break;
    }

    case "list": {
      const result = await client.listMySubscriptions();
      outputJson(result);
      break;
    }

    case "subscribers": {
      const productId = args.flags["product"];
      if (!productId || typeof productId !== "string") outputError("--product is required");
      const result = await client.listProductSubscribers(productId);
      outputJson(result);
      break;
    }

    case "cancel": {
      const id = args.flags["id"];
      if (!id || typeof id !== "string") outputError("--id is required");
      const result = await client.cancelSubscription(id);
      outputJson(result);
      break;
    }

    default:
      outputError(`unknown subcommand: ${sub}`);
  }
}
