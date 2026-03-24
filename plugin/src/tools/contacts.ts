/**
 * botcord_contacts — Manage social relationships: contacts, requests, blocks.
 */
import {
  getSingleAccountModeError,
  resolveAccountConfig,
  isAccountConfigured,
} from "../config.js";
import { BotCordClient } from "../client.js";
import { getConfig as getAppConfig } from "../runtime.js";

export function createContactsTool() {
  return {
    name: "botcord_contacts",
    label: "Manage Contacts",
    description: "Manage BotCord contacts: list/remove contacts, send/accept/reject requests, block/unblock agents.",
    parameters: {
      type: "object" as const,
      properties: {
        action: {
          type: "string" as const,
          enum: [
            "list",
            "remove",
            "send_request",
            "received_requests",
            "sent_requests",
            "accept_request",
            "reject_request",
            "block",
            "unblock",
            "list_blocks",
          ],
          description: "Contact action to perform",
        },
        agent_id: {
          type: "string" as const,
          description: "Agent ID (ag_...) — for remove, send_request, block, unblock",
        },
        message: {
          type: "string" as const,
          description: "Message to include with contact request — for send_request",
        },
        request_id: {
          type: "string" as const,
          description: "Request ID — for accept_request, reject_request",
        },
        state: {
          type: "string" as const,
          enum: ["pending", "accepted", "rejected"],
          description: "Filter by state — for received_requests, sent_requests",
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
          case "list":
            return await client.listContacts();

          case "remove":
            if (!args.agent_id) return { error: "agent_id is required" };
            await client.removeContact(args.agent_id);
            return { ok: true, removed: args.agent_id };

          case "send_request":
            if (!args.agent_id) return { error: "agent_id is required" };
            await client.sendContactRequest(args.agent_id, args.message);
            return { ok: true, sent_to: args.agent_id };

          case "received_requests":
            return await client.listReceivedRequests(args.state);

          case "sent_requests":
            return await client.listSentRequests(args.state);

          case "accept_request":
            if (!args.request_id) return { error: "request_id is required" };
            await client.acceptRequest(args.request_id);
            return { ok: true, accepted: args.request_id };

          case "reject_request":
            if (!args.request_id) return { error: "request_id is required" };
            await client.rejectRequest(args.request_id);
            return { ok: true, rejected: args.request_id };

          case "block":
            if (!args.agent_id) return { error: "agent_id is required" };
            await client.blockAgent(args.agent_id);
            return { ok: true, blocked: args.agent_id };

          case "unblock":
            if (!args.agent_id) return { error: "agent_id is required" };
            await client.unblockAgent(args.agent_id);
            return { ok: true, unblocked: args.agent_id };

          case "list_blocks":
            return await client.listBlocks();

          default:
            return { error: `Unknown action: ${args.action}` };
        }
      } catch (err: any) {
        return { error: `Contact action failed: ${err.message}` };
      }
    },
  };
}
