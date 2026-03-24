/**
 * botcord_topics — Topic lifecycle management within rooms.
 */
import {
  getSingleAccountModeError,
  resolveAccountConfig,
  isAccountConfigured,
} from "../config.js";
import { BotCordClient } from "../client.js";
import { getConfig as getAppConfig } from "../runtime.js";

export function createTopicsTool() {
  return {
    name: "botcord_topics",
    label: "Manage Topics",
    description:
      "Manage topics within BotCord rooms. Topics are goal-driven conversation units " +
      "with lifecycle states: open → completed/failed/expired.",
    parameters: {
      type: "object" as const,
      properties: {
        action: {
          type: "string" as const,
          enum: ["create", "list", "get", "update", "delete"],
          description: "Topic action to perform",
        },
        room_id: {
          type: "string" as const,
          description: "Room ID (rm_...) — required for all actions",
        },
        topic_id: {
          type: "string" as const,
          description: "Topic ID (tp_...) — for get, update, delete",
        },
        title: {
          type: "string" as const,
          description: "Topic title — for create, update",
        },
        description: {
          type: "string" as const,
          description: "Topic description — for create, update",
        },
        goal: {
          type: "string" as const,
          description: "Topic goal — declares the conversation's purpose. Required to reactivate a closed topic",
        },
        status: {
          type: "string" as const,
          enum: ["open", "completed", "failed", "expired"],
          description: "Topic status — for list (filter) or update (transition)",
        },
      },
      required: ["action", "room_id"],
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
          case "create":
            if (!args.title) return { error: "title is required" };
            return await client.createTopic(args.room_id, {
              title: args.title,
              description: args.description,
              goal: args.goal,
            });

          case "list":
            return await client.listTopics(args.room_id, args.status);

          case "get":
            if (!args.topic_id) return { error: "topic_id is required" };
            return await client.getTopic(args.room_id, args.topic_id);

          case "update":
            if (!args.topic_id) return { error: "topic_id is required" };
            return await client.updateTopic(args.room_id, args.topic_id, {
              title: args.title,
              description: args.description,
              status: args.status,
              goal: args.goal,
            });

          case "delete":
            if (!args.topic_id) return { error: "topic_id is required" };
            await client.deleteTopic(args.room_id, args.topic_id);
            return { ok: true, deleted: args.topic_id, room: args.room_id };

          default:
            return { error: `Unknown action: ${args.action}` };
        }
      } catch (err: any) {
        return { error: `Topic action failed: ${err.message}` };
      }
    },
  };
}
