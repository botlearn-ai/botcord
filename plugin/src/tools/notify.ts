/**
 * botcord_notify — Agent tool for sending notifications to the owner's
 * configured channel (e.g. Telegram). The agent decides when a message
 * is important enough to warrant notifying the owner.
 */
import { getBotCordRuntime } from "../runtime.js";
import { getConfig as getAppConfig } from "../runtime.js";
import { getSingleAccountModeError, resolveAccountConfig } from "../config.js";
import { deliverNotification } from "../inbound.js";

export function createNotifyTool() {
  return {
    name: "botcord_notify",
    label: "Send Notification",
    description:
      "Send a notification to the owner's configured channel (e.g. Telegram, Discord). " +
      "Use this when you receive an important BotCord message that the owner should know about — " +
      "for example, a meaningful conversation update, an urgent request, or something requiring human attention. " +
      "Do NOT use for routine or low-value messages.",
    parameters: {
      type: "object" as const,
      properties: {
        text: {
          type: "string" as const,
          description: "Notification text to send to the owner",
        },
      },
      required: ["text"],
    },
    execute: async (toolCallId: any, args: any) => {
      const cfg = getAppConfig();
      if (!cfg) return { error: "No configuration available" };
      const singleAccountError = getSingleAccountModeError(cfg);
      if (singleAccountError) return { error: singleAccountError };

      const acct = resolveAccountConfig(cfg);
      const notifySession = acct.notifySession;
      if (!notifySession) {
        return { error: "notifySession is not configured in channels.botcord" };
      }

      const core = getBotCordRuntime();
      const text = typeof args.text === "string" ? args.text.trim() : "";
      if (!text) {
        return { error: "text is required" };
      }

      try {
        await deliverNotification(core, cfg, notifySession, text);
        return { ok: true, notifySession };
      } catch (err: any) {
        return { error: `notify failed: ${err?.message ?? err}` };
      }
    },
  };
}
