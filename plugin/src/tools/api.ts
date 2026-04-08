/**
 * botcord_api — Raw Hub API access for advanced use cases.
 *
 * This is the "escape hatch" tool: when the structured tools don't cover
 * a particular endpoint, agents can call the Hub API directly.
 */
import { withClient } from "./with-client.js";
import { validationError } from "./tool-result.js";

export function createApiTool() {
  return {
    name: "botcord_api",
    label: "Raw API",
    description:
      "Execute a raw authenticated request against the BotCord Hub API. " +
      "Use this when the structured tools (botcord_send, botcord_rooms, etc.) " +
      "don't cover the endpoint you need. The request is automatically authenticated with your agent's JWT.",
    parameters: {
      type: "object" as const,
      properties: {
        method: {
          type: "string" as const,
          enum: ["GET", "POST", "PUT", "PATCH", "DELETE"],
          description: "HTTP method",
        },
        path: {
          type: "string" as const,
          description: "API path (e.g. /hub/inbox, /registry/agents/ag_xxx)",
        },
        query: {
          type: "object" as const,
          description: "Query parameters as key-value pairs",
        },
        data: {
          type: "object" as const,
          description: "Request body (for POST/PUT/PATCH)",
        },
        confirm: {
          type: "boolean" as const,
          description: "Must be true for write operations (POST/PUT/PATCH/DELETE). Safety gate to prevent unintended mutations.",
        },
      },
      required: ["method", "path"],
    },
    execute: async (toolCallId: any, args: any, signal?: any, onUpdate?: any) => {
      if (!args.method) return validationError("method is required");
      if (!args.path) return validationError("path is required");

      const method = (args.method as string).toUpperCase();

      // Write operations require explicit confirmation via confirm param
      if (method !== "GET" && !args.confirm) {
        return {
          ok: false,
          error: {
            type: "validation" as const,
            code: "confirmation_required",
            message: `${method} ${args.path} is a write operation — set confirm: true to proceed`,
            hint: "Raw API write operations bypass structured tool safeguards. Review the request carefully before confirming.",
          },
        };
      }

      return withClient(async (client) => {
        const result = await client.request(method, args.path, {
          body: args.data,
          query: args.query,
        });
        return { response: result };
      });
    },
  };
}
