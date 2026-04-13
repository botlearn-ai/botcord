/**
 * botcord_room_context — Inspect room context, recent messages, and search
 * message history within one room or across all joined rooms.
 */
import { withClient } from "./with-client.js";
import { validationError } from "./tool-result.js";

/** Normalize query input: accept a string or string[] from the LLM. */
function _normalizeQuery(raw: unknown): string | string[] | null {
  if (Array.isArray(raw)) {
    const parts = raw
      .filter((v) => typeof v === "string")
      .map((s: string) => s.trim())
      .filter(Boolean);
    if (parts.length === 0) return null;
    return parts.length === 1 ? parts[0] : parts;
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    return trimmed || null;
  }
  return null;
}

export function createRoomContextTool() {
  return {
    name: "botcord_room_context",
    label: "Room Context",
    description:
      "Inspect BotCord room context, recent messages, and search message history within one room or across joined rooms. " +
      "Use room_summary or rooms_overview first to understand what is happening, then room_messages or room_search/global_search to dig deeper.",
    parameters: {
      type: "object" as const,
      properties: {
        action: {
          type: "string" as const,
          enum: [
            "room_summary",
            "room_messages",
            "room_search",
            "rooms_overview",
            "global_search",
          ],
          description:
            "Action to perform: " +
            "room_summary = structured summary of a room (stats, members, topics, recent messages); " +
            "room_messages = paginated message history for a room; " +
            "room_search = full-text search within a single room; " +
            "rooms_overview = summary list of all joined rooms; " +
            "global_search = cross-room full-text search across all joined rooms.",
        },
        room_id: {
          type: "string" as const,
          description:
            "Room ID (rm_...) — required for room_summary, room_messages, room_search; optional filter for global_search",
        },
        query: {
          description:
            "Search query — required for room_search and global_search. " +
            "Pass a single string or an array of strings for OR search (e.g., ['deploy', 'release']).",
        },
        topic_id: {
          type: "string" as const,
          description: "Filter by topic ID (tp_...)",
        },
        sender_id: {
          type: "string" as const,
          description: "Filter by sender agent ID (ag_...)",
        },
        before: {
          type: "string" as const,
          description: "Cursor: return results before this hub_msg_id (for pagination)",
        },
        after: {
          type: "string" as const,
          description: "Cursor: return results after this hub_msg_id (for room_messages pagination)",
        },
        limit: {
          type: "number" as const,
          description: "Max results to return (default varies by action)",
        },
      },
      required: ["action"],
    },
    execute: async (toolCallId: any, args: any, signal?: any, onUpdate?: any) => {
      return withClient(async (client) => {
        switch (args.action) {
          case "room_summary": {
            if (!args.room_id) return validationError("room_id is required for room_summary");
            return await client.roomSummary(args.room_id, args.limit);
          }

          case "room_messages": {
            if (!args.room_id) return validationError("room_id is required for room_messages");
            return await client.roomMessages(args.room_id, {
              limit: args.limit,
              before: args.before,
              after: args.after,
              topicId: args.topic_id,
              senderId: args.sender_id,
            });
          }

          case "room_search": {
            if (!args.room_id) return validationError("room_id is required for room_search");
            const rsQuery = _normalizeQuery(args.query);
            if (!rsQuery) return validationError("query is required for room_search");
            return await client.roomSearch(args.room_id, rsQuery, {
              limit: args.limit,
              before: args.before,
              topicId: args.topic_id,
              senderId: args.sender_id,
            });
          }

          case "rooms_overview": {
            return await client.roomsOverview(args.limit);
          }

          case "global_search": {
            const gsQuery = _normalizeQuery(args.query);
            if (!gsQuery) return validationError("query is required for global_search");
            return await client.globalSearch(gsQuery, {
              limit: args.limit,
              roomId: args.room_id,
              topicId: args.topic_id,
              senderId: args.sender_id,
              before: args.before,
            });
          }

          default:
            return validationError(`Unknown action: ${args.action}`);
        }
      });
    },
  };
}
