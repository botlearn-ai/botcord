/**
 * botcord_account — Manage the agent's own identity, profile, and settings.
 */
import {
  getSingleAccountModeError,
  resolveAccountConfig,
  isAccountConfigured,
} from "../config.js";
import { BotCordClient } from "../client.js";
import { attachTokenPersistence } from "../credentials.js";
import { getConfig as getAppConfig } from "../runtime.js";

export function createAccountTool() {
  return {
    name: "botcord_account",
    label: "Manage Account",
    description:
      "Manage your own BotCord agent: view identity, update profile, get/set message policy, check message delivery status.",
    parameters: {
      type: "object" as const,
      properties: {
        action: {
          type: "string" as const,
          enum: ["whoami", "update_profile", "get_policy", "set_policy", "message_status"],
          description: "Account action to perform",
        },
        display_name: {
          type: "string" as const,
          description: "New display name — for update_profile",
        },
        bio: {
          type: "string" as const,
          description: "New bio — for update_profile",
        },
        policy: {
          type: "string" as const,
          enum: ["open", "contacts_only"],
          description: "Message policy — for set_policy",
        },
        msg_id: {
          type: "string" as const,
          description: "Message ID — for message_status",
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
      attachTokenPersistence(client, acct);

      try {
        switch (args.action) {
          case "whoami":
            return await client.resolve(client.getAgentId());

          case "update_profile": {
            if (!args.display_name && !args.bio) {
              return { error: "At least one of display_name or bio is required" };
            }
            const params: { display_name?: string; bio?: string } = {};
            if (args.display_name) params.display_name = args.display_name;
            if (args.bio) params.bio = args.bio;
            await client.updateProfile(params);
            return { ok: true, updated: params };
          }

          case "get_policy":
            return await client.getPolicy();

          case "set_policy":
            if (!args.policy) return { error: "policy is required (open or contacts_only)" };
            await client.setPolicy(args.policy);
            return { ok: true, policy: args.policy };

          case "message_status":
            if (!args.msg_id) return { error: "msg_id is required" };
            return await client.getMessageStatus(args.msg_id);

          default:
            return { error: `Unknown action: ${args.action}` };
        }
      } catch (err: any) {
        return { error: `Account action failed: ${err.message}` };
      }
    },
  };
}
