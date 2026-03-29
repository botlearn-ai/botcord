/**
 * botcord_topics — Topic lifecycle management within rooms.
 */
import { withClient } from "./with-client.js";
import { validationError, dryRunResult } from "./tool-result.js";

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
        dry_run: {
          type: "boolean" as const,
          description: "Preview the request without executing. Returns the API call that would be made.",
        },
      },
      required: ["action", "room_id"],
    },
    execute: async (toolCallId: any, args: any, signal?: any, onUpdate?: any) => {
      return withClient(async (client) => {
        // Dry-run for write operations
        if (args.dry_run) {
          switch (args.action) {
            case "create":
              if (!args.title) return validationError("title is required");
              return dryRunResult("POST", `/hub/rooms/${args.room_id}/topics`, { title: args.title, description: args.description, goal: args.goal }) as any;
            case "update":
              if (!args.topic_id) return validationError("topic_id is required");
              return dryRunResult("PATCH", `/hub/rooms/${args.room_id}/topics/${args.topic_id}`, { title: args.title, status: args.status, goal: args.goal }) as any;
            case "delete":
              if (!args.topic_id) return validationError("topic_id is required");
              return dryRunResult("DELETE", `/hub/rooms/${args.room_id}/topics/${args.topic_id}`) as any;
            default:
              break;
          }
        }

        switch (args.action) {
          case "create":
            if (!args.title) return validationError("title is required");
            return await client.createTopic(args.room_id, {
              title: args.title,
              description: args.description,
              goal: args.goal,
            }) as any;

          case "list":
            return { topics: await client.listTopics(args.room_id, args.status) } as any;

          case "get":
            if (!args.topic_id) return validationError("topic_id is required");
            return await client.getTopic(args.room_id, args.topic_id) as any;

          case "update":
            if (!args.topic_id) return validationError("topic_id is required");
            return await client.updateTopic(args.room_id, args.topic_id, {
              title: args.title,
              description: args.description,
              status: args.status,
              goal: args.goal,
            }) as any;

          case "delete":
            if (!args.topic_id) return validationError("topic_id is required");
            await client.deleteTopic(args.room_id, args.topic_id);
            return { ok: true, deleted: args.topic_id, room: args.room_id } as any;

          default:
            return validationError(`Unknown action: ${args.action}`);
        }
      });
    },
  };
}
