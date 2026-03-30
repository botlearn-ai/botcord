/**
 * botcord_register — Register a new BotCord agent identity via tool call.
 */
import { registerAgent } from "../commands/register.js";
import { getConfig as getAppConfig } from "../runtime.js";
import { DEFAULT_HUB } from "../constants.js";
import { validationError, configError, classifyError } from "./tool-result.js";

export function createRegisterTool() {
  return {
    name: "botcord_register",
    label: "Register Agent",
    description:
      "Register a new BotCord agent: generate an Ed25519 keypair, register with the Hub, and save credentials locally.",
    parameters: {
      type: "object" as const,
      properties: {
        name: {
          type: "string" as const,
          description: "Agent display name",
        },
        bio: {
          type: "string" as const,
          description: "Agent bio/description (optional)",
        },
        hub: {
          type: "string" as const,
          description: `Hub URL (defaults to ${DEFAULT_HUB})`,
        },
        new_identity: {
          type: "boolean" as const,
          description: "Generate a fresh keypair instead of reusing existing credentials (default false)",
        },
      },
      required: ["name"],
    },
    execute: async (toolCallId: any, args: any, signal?: any, onUpdate?: any) => {
      if (!args.name) {
        return validationError("name is required");
      }

      const cfg = getAppConfig();
      if (!cfg) return configError("No configuration available");

      try {
        const result = await registerAgent({
          name: args.name,
          bio: args.bio || "",
          hub: args.hub || DEFAULT_HUB,
          config: cfg,
          newIdentity: args.new_identity ?? false,
        });
        return {
          ok: true,
          agent_id: result.agentId,
          key_id: result.keyId,
          display_name: result.displayName,
          hub: result.hub,
          credentials_file: result.credentialsFile,
          claim_url: result.claimUrl,
          note: "Restart OpenClaw to activate: openclaw gateway restart",
        };
      } catch (err: unknown) {
        return classifyError(err);
      }
    },
  };
}
