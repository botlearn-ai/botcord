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
      const path = args.path as string;

      // Validate path to prevent SSRF / path traversal.
      const ALLOWED_PREFIXES = ["/hub/", "/registry/", "/wallet/", "/subscriptions/", "/app/"];

      // Reject absolute URLs (scheme://...) — path must be relative to Hub
      if (/^[a-z][a-z0-9+.-]*:/i.test(path)) {
        return validationError(
          "Absolute URLs are not allowed — provide a path like /hub/inbox",
          "Path traversal and arbitrary URLs are not allowed.",
        );
      }

      // Reject query strings embedded in path — callers must use the query field.
      // URL normalization strips ?… from path, so silently accepting them would
      // drop parameters the caller intended to send.
      if (path.includes("?")) {
        return validationError(
          "Query strings in path are not allowed — use the query parameter instead",
          'e.g. path: "/hub/search", query: { q: "deploy" }',
        );
      }

      // Resolve against dummy base to normalize percent-encoded traversal
      // (e.g. /%2e%2e/ → /../ → resolved away by URL constructor)
      let resolvedPath: string;
      try {
        resolvedPath = new URL(path, "http://localhost").pathname;
      } catch {
        return validationError("Invalid path", "Could not parse the provided path as a URL.");
      }
      const normalized = resolvedPath.replace(/\/+/g, "/"); // collapse duplicate slashes
      if (normalized.includes("..") || !ALLOWED_PREFIXES.some((p) => normalized.startsWith(p))) {
        return validationError(
          `path must start with one of: ${ALLOWED_PREFIXES.join(", ")}`,
          "Path traversal and arbitrary URLs are not allowed.",
        );
      }

      // Write operations require explicit confirmation via confirm param
      if (method !== "GET" && !args.confirm) {
        return {
          ok: false,
          error: {
            type: "validation" as const,
            code: "confirmation_required",
            message: `${method} ${path} is a write operation — set confirm: true to proceed`,
            hint: "Raw API write operations bypass structured tool safeguards. Review the request carefully before confirming.",
          },
        };
      }

      return withClient(async (client) => {
        // Use the normalized path so the request matches what was validated
        const result = await client.request(method, normalized, {
          body: args.data,
          query: args.query,
        });
        return { response: result };
      });
    },
  };
}
