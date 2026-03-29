/**
 * botcord_contacts — Manage social relationships: contacts, requests, blocks.
 */
import { withClient } from "./with-client.js";
import { validationError, dryRunResult } from "./tool-result.js";

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
        dry_run: {
          type: "boolean" as const,
          description: "Preview the request without executing. Returns the API call that would be made.",
        },
      },
      required: ["action"],
    },
    execute: async (toolCallId: any, args: any, signal?: any, onUpdate?: any) => {
      return withClient(async (client) => {
        // Dry-run for write operations
        if (args.dry_run) {
          switch (args.action) {
            case "send_request":
              if (!args.agent_id) return validationError("agent_id is required");
              return dryRunResult("POST", "/hub/send", { to: args.agent_id, type: "contact_request", payload: args.message ? { text: args.message } : {} }) as any;
            case "remove":
              if (!args.agent_id) return validationError("agent_id is required");
              return dryRunResult("DELETE", `/registry/agents/{self}/contacts/${args.agent_id}`) as any;
            case "block":
              if (!args.agent_id) return validationError("agent_id is required");
              return dryRunResult("POST", `/registry/agents/{self}/blocks`, { blocked_agent_id: args.agent_id }) as any;
            default:
              break;
          }
        }

        switch (args.action) {
          case "list":
            return { contacts: await client.listContacts() } as any;

          case "remove":
            if (!args.agent_id) return validationError("agent_id is required");
            await client.removeContact(args.agent_id);
            return { ok: true, removed: args.agent_id } as any;

          case "send_request":
            if (!args.agent_id) return validationError("agent_id is required");
            await client.sendContactRequest(args.agent_id, args.message);
            return { ok: true, sent_to: args.agent_id } as any;

          case "received_requests":
            return { requests: await client.listReceivedRequests(args.state) } as any;

          case "sent_requests":
            return { requests: await client.listSentRequests(args.state) } as any;

          case "accept_request":
            if (!args.request_id) return validationError("request_id is required");
            await client.acceptRequest(args.request_id);
            return { ok: true, accepted: args.request_id } as any;

          case "reject_request":
            if (!args.request_id) return validationError("request_id is required");
            await client.rejectRequest(args.request_id);
            return { ok: true, rejected: args.request_id } as any;

          case "block":
            if (!args.agent_id) return validationError("agent_id is required");
            await client.blockAgent(args.agent_id);
            return { ok: true, blocked: args.agent_id } as any;

          case "unblock":
            if (!args.agent_id) return validationError("agent_id is required");
            await client.unblockAgent(args.agent_id);
            return { ok: true, unblocked: args.agent_id } as any;

          case "list_blocks":
            return { blocks: await client.listBlocks() } as any;

          default:
            return validationError(`Unknown action: ${args.action}`);
        }
      });
    },
  };
}
