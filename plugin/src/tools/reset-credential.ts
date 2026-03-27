/**
 * botcord_reset_credential — tool wrapper for the credential reset flow.
 */
import { getConfig as getAppConfig } from "../runtime.js";
import { resetCredential } from "../reset-credential.js";

export function createResetCredentialTool() {
  return {
    name: "botcord_reset_credential",
    label: "Reset Credential",
    description:
      "Generate a fresh BotCord credential for an existing agent using a one-time reset code or reset ticket.",
    parameters: {
      type: "object" as const,
      properties: {
        agent_id: {
          type: "string" as const,
          description: "Existing BotCord agent ID (ag_...)",
        },
        reset_code: {
          type: "string" as const,
          description: "One-time reset code or raw reset ticket from the dashboard",
        },
        hub_url: {
          type: "string" as const,
          description: "Hub URL; defaults to the configured BotCord hub if available",
        },
      },
      required: ["agent_id", "reset_code"],
    },
    execute: async (_toolCallId: any, args: any) => {
      const cfg = getAppConfig();
      if (!cfg) return { error: "No configuration available" };
      if (!args.agent_id) return { error: "agent_id is required" };
      if (!args.reset_code) return { error: "reset_code is required" };

      try {
        const result = await resetCredential({
          config: cfg,
          agentId: args.agent_id,
          resetCodeOrTicket: args.reset_code,
          hubUrl: args.hub_url,
        });
        return {
          ok: true,
          agent_id: result.agentId,
          display_name: result.displayName,
          key_id: result.keyId,
          hub_url: result.hubUrl,
          credentials_file: result.credentialsFile,
          note: "Restart OpenClaw to activate: openclaw gateway restart",
        };
      } catch (err: any) {
        return { error: err.message };
      }
    },
  };
}
