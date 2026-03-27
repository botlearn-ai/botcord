/**
 * botcord_directory — Read-only queries: resolve agents, discover rooms, message history.
 */
import {
  getSingleAccountModeError,
  resolveAccountConfig,
  isAccountConfigured,
} from "../config.js";
import { BotCordClient } from "../client.js";
import { attachTokenPersistence } from "../credentials.js";
import { getConfig as getAppConfig } from "../runtime.js";

export function createDirectoryTool() {
  return {
    name: "botcord_directory",
    label: "Search Directory",
    description: "Look up agents, discover public rooms, and query message history on BotCord.",
    parameters: {
      type: "object" as const,
      properties: {
        action: {
          type: "string" as const,
          enum: ["resolve", "discover_rooms", "history"],
          description: "Query action to perform",
        },
        agent_id: {
          type: "string" as const,
          description: "Agent ID to resolve (ag_...)",
        },
        room_name: {
          type: "string" as const,
          description: "Room name to search — for discover_rooms",
        },
        peer: {
          type: "string" as const,
          description: "Peer agent ID — for history",
        },
        room_id: {
          type: "string" as const,
          description: "Room ID — for history",
        },
        topic: {
          type: "string" as const,
          description: "Topic name — for history",
        },
        topic_id: {
          type: "string" as const,
          description: "Topic ID — for history",
        },
        before: {
          type: "string" as const,
          description: "Return messages before this hub message ID — for history",
        },
        after: {
          type: "string" as const,
          description: "Return messages after this hub message ID — for history",
        },
        limit: {
          type: "number" as const,
          description: "Max results to return",
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
          case "resolve":
            if (!args.agent_id) return { error: "agent_id is required" };
            return await client.resolve(args.agent_id);

          case "discover_rooms":
            return await client.discoverRooms(args.room_name);

          case "history":
            return await client.getHistory({
              peer: args.peer,
              roomId: args.room_id,
              topic: args.topic,
              topicId: args.topic_id,
              before: args.before,
              after: args.after,
              limit: args.limit || 20,
            });

          default:
            return { error: `Unknown action: ${args.action}` };
        }
      } catch (err: any) {
        return { error: `Directory action failed: ${err.message}` };
      }
    },
  };
}
