/**
 * botcord_notify — Agent tool for sending notifications to the owner's
 * configured channel (e.g. Telegram). The agent decides when a message
 * is important enough to warrant notifying the owner.
 */
import { getBotCordRuntime } from "../runtime.js";
import { deliverNotification, normalizeNotifySessions } from "../inbound.js";
import { isAccountConfigured } from "../config.js";
import { BotCordClient } from "../client.js";
import { attachTokenPersistence } from "../credentials.js";
import { withConfig } from "./with-client.js";
import { validationError } from "./tool-result.js";

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
      return withConfig(async (cfg, acct) => {
        const sessions = normalizeNotifySessions(acct.notifySession);
        if (sessions.length === 0) {
          return validationError(
            "notifySession is not configured in channels.botcord",
          );
        }

        const core = getBotCordRuntime();
        const text = typeof args.text === "string" ? args.text.trim() : "";
        if (!text) {
          return validationError("text is required");
        }

        const errors: string[] = [];
        for (const ns of sessions) {
          try {
            await deliverNotification(core, cfg, ns, text);
          } catch (err: any) {
            errors.push(`${ns}: ${err?.message ?? err}`);
          }
        }

        // Also push notification to owner's dashboard via Hub API
        if (isAccountConfigured(acct)) {
          try {
            const client = new BotCordClient(acct);
            attachTokenPersistence(client, acct);
            await client.notifyOwner(text);
          } catch (err: any) {
            errors.push(`owner-chat: ${err?.message ?? err}`);
          }
        }

        if (errors.length > 0) {
          return {
            ok: errors.length < sessions.length,
            notifySessions: sessions,
            errors,
          };
        }
        return { ok: true, notifySessions: sessions };
      });
    },
  };
}
