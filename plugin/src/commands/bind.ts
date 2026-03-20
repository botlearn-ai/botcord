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
    handler: async (args?: string) => {
      const bindTicket = (args || "").trim();
      if (!bindTicket) {
        return { text: "[FAIL] Usage: /botcord_bind <bind_ticket>" };
      }

      const result = await executeBind(bindTicket);

      if ("error" in result) {
        return { text: `[FAIL] ${result.error}` };
      }

      return { text: `[OK] Agent successfully bound to dashboard.` };
    },
  };
}
