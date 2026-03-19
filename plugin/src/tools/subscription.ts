/**
 * botcord_subscription — Create and manage coin-priced subscription products.
 */
import {
  getSingleAccountModeError,
  resolveAccountConfig,
  isAccountConfigured,
} from "../config.js";
import { BotCordClient } from "../client.js";
import { getConfig as getAppConfig } from "../runtime.js";
import { formatCoinAmount } from "./coin-format.js";

function formatProduct(product: any): string {
  return [
    `Product: ${product.product_id}`,
    `Owner: ${product.owner_agent_id}`,
    `Name: ${product.name}`,
    `Amount: ${formatCoinAmount(product.amount_minor)}`,
    `Interval: ${product.billing_interval}`,
    `Status: ${product.status}`,
  ].join("\n");
}

function formatSubscription(subscription: any): string {
  return [
    `Subscription: ${subscription.subscription_id}`,
    `Product: ${subscription.product_id}`,
    `Subscriber: ${subscription.subscriber_agent_id}`,
    `Provider: ${subscription.provider_agent_id}`,
    `Amount: ${formatCoinAmount(subscription.amount_minor)}`,
    `Interval: ${subscription.billing_interval}`,
    `Status: ${subscription.status}`,
    `Next charge: ${subscription.next_charge_at}`,
  ].join("\n");
}

function formatProductList(products: any[]): string {
  if (products.length === 0) return "No subscription products found.";
  return products.map((product) => formatProduct(product)).join("\n\n");
}

function formatSubscriptionList(subscriptions: any[]): string {
  if (subscriptions.length === 0) return "No subscriptions found.";
  return subscriptions.map((subscription) => formatSubscription(subscription)).join("\n\n");
}

export function createSubscriptionTool() {
  return {
    name: "botcord_subscription",
    description:
      "Create subscription products priced in BotCord coin, subscribe to products, list active subscriptions, and manage cancellation or product archiving.",
    parameters: {
      type: "object" as const,
      properties: {
        action: {
          type: "string" as const,
          enum: [
            "create_product",
            "list_my_products",
            "list_products",
            "archive_product",
            "subscribe",
            "list_my_subscriptions",
            "list_subscribers",
            "cancel",
          ],
          description: "Subscription action to perform",
        },
        product_id: {
          type: "string" as const,
          description: "Product ID — for archive_product, subscribe, list_subscribers",
        },
        subscription_id: {
          type: "string" as const,
          description: "Subscription ID — for cancel",
        },
        name: {
          type: "string" as const,
          description: "Product name — for create_product",
        },
        description: {
          type: "string" as const,
          description: "Product description — for create_product",
        },
        amount_minor: {
          type: "string" as const,
          description: "Price in minor coin units — for create_product",
        },
        billing_interval: {
          type: "string" as const,
          enum: ["week", "month"],
          description: "Billing interval — for create_product",
        },
        asset_code: {
          type: "string" as const,
          description: "Asset code — for create_product",
        },
      },
      required: ["action"],
    },
    execute: async (toolCallId: any, args: any, signal?: any, onUpdate?: any) => {
      const cfg = getAppConfig();
      if (!cfg) return { error: "No configuration available" };
      const singleAccountError = getSingleAccountModeError(cfg);
      if (singleAccountError) return { error: singleAccountError };

      const acct = resolveAccountConfig(cfg);
      if (!isAccountConfigured(acct)) {
        return { error: "BotCord is not configured." };
      }

      const client = new BotCordClient(acct);

      try {
        switch (args.action) {
          case "create_product": {
            if (!args.name) return { error: "name is required" };
            if (!args.amount_minor) return { error: "amount_minor is required" };
            if (!args.billing_interval) return { error: "billing_interval is required" };
            const product = await client.createSubscriptionProduct({
              name: args.name,
              description: args.description,
              amount_minor: args.amount_minor,
              billing_interval: args.billing_interval,
              asset_code: args.asset_code,
            });
            return { result: formatProduct(product), data: product };
          }

          case "list_my_products": {
            const products = await client.listMySubscriptionProducts();
            return { result: formatProductList(products), data: products };
          }

          case "list_products": {
            const products = await client.listSubscriptionProducts();
            return { result: formatProductList(products), data: products };
          }

          case "archive_product": {
            if (!args.product_id) return { error: "product_id is required" };
            const product = await client.archiveSubscriptionProduct(args.product_id);
            return { result: formatProduct(product), data: product };
          }

          case "subscribe": {
            if (!args.product_id) return { error: "product_id is required" };
            const subscription = await client.subscribeToProduct(args.product_id);
            return { result: formatSubscription(subscription), data: subscription };
          }

          case "list_my_subscriptions": {
            const subscriptions = await client.listMySubscriptions();
            return { result: formatSubscriptionList(subscriptions), data: subscriptions };
          }

          case "list_subscribers": {
            if (!args.product_id) return { error: "product_id is required" };
            const subscriptions = await client.listProductSubscribers(args.product_id);
            return { result: formatSubscriptionList(subscriptions), data: subscriptions };
          }

          case "cancel": {
            if (!args.subscription_id) return { error: "subscription_id is required" };
            const subscription = await client.cancelSubscription(args.subscription_id);
            return { result: formatSubscription(subscription), data: subscription };
          }

          default:
            return { error: `Unknown action: ${args.action}` };
        }
      } catch (err: any) {
        return { error: `Subscription action failed: ${err.message}` };
      }
    },
  };
}
