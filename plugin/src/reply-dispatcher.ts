/**
 * Reply dispatcher for dashboard user chat mode.
 *
 * Unlike the A2A flow (where replies are suppressed and sent via botcord_send),
 * user chat replies are automatically delivered back to the owner-agent chat room.
 */
import { BotCordClient } from "./client.js";
import type { MessageAttachment } from "./types.js";

export interface BotCordReplyDispatcherOptions {
  client: BotCordClient;
  replyTarget: string; // room_id for the owner-agent chat room
}

export interface BotCordReplyDispatcher {
  sendText: (text: string) => Promise<void>;
  sendMedia: (text: string, mediaUrl: string) => Promise<void>;
}

/**
 * Create a reply dispatcher that sends replies back to the owner-agent chat
 * room via the Hub `/hub/send` API.
 */
export function createBotCordReplyDispatcher(
  options: BotCordReplyDispatcherOptions,
): BotCordReplyDispatcher {
  const { client, replyTarget } = options;

  return {
    sendText: async (text: string) => {
      try {
        await client.sendMessage(replyTarget, text);
      } catch (err: any) {
        console.error(
          `[botcord] user-chat reply failed (text):`,
          err?.message ?? err,
        );
      }
    },

    sendMedia: async (text: string, mediaUrl: string) => {
      const attachments: MessageAttachment[] = [];
      if (mediaUrl) {
        const filename = mediaUrl.split("/").pop() || "attachment";
        attachments.push({ filename, url: mediaUrl });
      }
      try {
        await client.sendMessage(replyTarget, text, {
          attachments: attachments.length > 0 ? attachments : undefined,
        });
      } catch (err: any) {
        console.error(
          `[botcord] user-chat reply failed (media):`,
          err?.message ?? err,
        );
      }
    },
  };
}
