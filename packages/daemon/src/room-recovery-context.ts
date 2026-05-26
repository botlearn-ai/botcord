/**
 * Build a compact, deterministic recovery block from recent Hub room messages.
 * Used when a runtime-native session is discarded and the same turn is retried
 * in a fresh session.
 */
import { BotCordClient, loadStoredCredentials } from "@botcord/protocol-core";
import { sanitizeUntrustedContent } from "./gateway/index.js";
import type { GatewayInboundMessage } from "./gateway/index.js";

interface CachedClient {
  client: BotCordClient;
  credentialsPath: string;
}

export interface RecentRoomMessagesRecoveryOptions {
  credentialPathByAgentId: Map<string, string>;
  defaultCredentialsPath?: string;
  hubBaseUrl?: string;
  limit?: number;
  log?: {
    warn: (msg: string, meta?: Record<string, unknown>) => void;
  };
}

interface RoomMessage {
  from?: string;
  from_name?: string;
  text?: string;
  type?: string;
  ts?: string;
  topic_id?: string | null;
  topic_title?: string | null;
}

const DEFAULT_RECENT_LIMIT = 20;
const MAX_MESSAGE_TEXT_CHARS = 1200;

function stripNewlines(s: string): string {
  return s.replace(/[\r\n]+/g, " ");
}

function messageLabel(m: RoomMessage): string {
  const name = typeof m.from_name === "string" && m.from_name.trim()
    ? m.from_name
    : typeof m.from === "string" && m.from.trim()
      ? m.from
      : "unknown";
  return sanitizeUntrustedContent(stripNewlines(name));
}

function formatRecentMessages(messages: RoomMessage[]): string {
  if (messages.length === 0) return "[Recent Room Messages]\n(none)";
  const chronological = [...messages].reverse();
  const lines = ["[Recent Room Messages]"];
  for (const m of chronological) {
    const text = typeof m.text === "string" ? m.text.trim() : "";
    if (!text) continue;
    const ts = typeof m.ts === "string" ? m.ts : "";
    const topic = typeof m.topic_title === "string" && m.topic_title.trim()
      ? ` topic=${sanitizeUntrustedContent(stripNewlines(m.topic_title))}`
      : typeof m.topic_id === "string" && m.topic_id
        ? ` topic=${sanitizeUntrustedContent(stripNewlines(m.topic_id))}`
        : "";
    const safeText = sanitizeUntrustedContent(
      text.length > MAX_MESSAGE_TEXT_CHARS
        ? `${text.slice(0, MAX_MESSAGE_TEXT_CHARS)}...`
        : text,
    );
    lines.push(`- ${ts ? `${ts} ` : ""}${messageLabel(m)}${topic}: ${safeText}`);
  }
  return lines.join("\n");
}

export function createRecentRoomMessagesRecoveryBuilder(
  opts: RecentRoomMessagesRecoveryOptions,
): (message: GatewayInboundMessage) => Promise<string | null> {
  const clients = new Map<string, CachedClient>();
  const limit = opts.limit ?? DEFAULT_RECENT_LIMIT;

  function getClient(accountId: string): BotCordClient | null {
    const existing = clients.get(accountId);
    if (existing) return existing.client;

    const credsPath =
      opts.credentialPathByAgentId.get(accountId) ?? opts.defaultCredentialsPath;
    if (!credsPath) {
      opts.log?.warn("daemon.recovery-context.no-credentials", { accountId });
      return null;
    }

    try {
      const creds = loadStoredCredentials(credsPath);
      const client = new BotCordClient({
        hubUrl: opts.hubBaseUrl ?? creds.hubUrl,
        agentId: creds.agentId,
        keyId: creds.keyId,
        privateKey: creds.privateKey,
        ...(creds.token ? { token: creds.token } : {}),
        ...(creds.tokenExpiresAt !== undefined
          ? { tokenExpiresAt: creds.tokenExpiresAt }
          : {}),
      });
      clients.set(accountId, { client, credentialsPath: credsPath });
      return client;
    } catch (err) {
      opts.log?.warn("daemon.recovery-context.client-init-failed", {
        accountId,
        credsPath,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  return async (message) => {
    const client = getClient(message.accountId);
    if (!client) return null;
    try {
      const body = await client.roomMessages(message.conversation.id, { limit });
      const messages = Array.isArray(body?.messages) ? body.messages as RoomMessage[] : [];
      return formatRecentMessages(messages);
    } catch (err) {
      opts.log?.warn("daemon.recovery-context.fetch-failed", {
        accountId: message.accountId,
        roomId: message.conversation.id,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  };
}
