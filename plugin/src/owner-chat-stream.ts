/**
 * Tracks active owner-chat streaming sessions.
 *
 * When the plugin processes an owner-chat message, a stream entry is created
 * so that the after_tool_call hook can stream execution blocks back to Hub.
 */
import type { BotCordClient } from "./client.js";

export interface OwnerChatStream {
  traceId: string;
  client: BotCordClient;
  seq: number;
}

/**
 * Map of OpenClaw session key -> active stream.
 * Entries are added when handleDashboardUserChat starts processing and
 * removed when dispatch completes.
 */
export const activeOwnerChatStreams = new Map<string, OwnerChatStream>();
