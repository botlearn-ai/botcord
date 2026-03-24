/**
 * /botcord_bind — Bind this agent to a BotCord web dashboard account using a bind ticket.
 */
import { executeBind } from "../tools/bind.js";

export function createBindCommand() {
  return {
    name: "botcord_bind",
    description:
      "Bind this agent to a BotCord web dashboard account using a bind ticket.",
    acceptsArgs: true,
    requireAuth: true,
    handler: async (ctx: any) => {
      const bindTicket = (ctx.args || "").trim();
      if (!bindTicket) {
        return { text: "[FAIL] Usage: /botcord_bind <bind_ticket>" };
      }

      const result = await executeBind(bindTicket);

      if ("error" in result) {
        return { text: `[FAIL] ${result.error}` };
      }

      const agentId = result.agent_id || "unknown";
      const displayName = result.display_name || agentId;
      return { text: `[OK] Agent ${displayName} (${agentId}) successfully bound to dashboard.` };
    },
  };
}
