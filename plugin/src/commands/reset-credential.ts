/**
 * /botcord_reset_credential — regenerate local credentials for an existing agent.
 */
import { getConfig as getAppConfig } from "../runtime.js";
import { resetCredential } from "../reset-credential.js";

export function createResetCredentialCommand() {
  return {
    name: "botcord_reset_credential",
    description:
      "Reset BotCord credentials for an existing agent using a one-time reset code or reset ticket.",
    acceptsArgs: true,
    requireAuth: true,
    handler: async (ctx: any) => {
      const rawArgs = String(ctx.args || "").trim();
      const parts = rawArgs.split(/\s+/).filter(Boolean);
      if (parts.length < 2) {
        return { text: "[FAIL] Usage: /botcord_reset_credential <agent_id> <reset_code_or_ticket> [hub_url]" };
      }

      const [agentId, resetCodeOrTicket, hubUrl] = parts;
      const cfg = getAppConfig();
      if (!cfg) return { text: "[FAIL] No OpenClaw configuration available" };

      try {
        const result = await resetCredential({
          config: cfg,
          agentId,
          resetCodeOrTicket,
          hubUrl,
        });
        return {
          text:
            `[OK] Reset credentials for ${result.displayName} (${result.agentId}). ` +
            `Saved to ${result.credentialsFile}. Restart OpenClaw to activate.`,
        };
      } catch (err: any) {
        return { text: `[FAIL] ${err.message}` };
      }
    },
  };
}
