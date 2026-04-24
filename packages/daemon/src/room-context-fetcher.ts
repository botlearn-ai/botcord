/**
 * Hub-backed implementation of `RoomContextFetcher`.
 *
 * Maintains a per-`accountId` `BotCordClient` (so token refreshes amortize
 * across turns) and translates the shared `/hub/rooms/:id` response into the
 * `{ room, members }` shape the builder expects. A single GET is enough —
 * Hub returns both the room record and its member list in one payload.
 */
import { BotCordClient, loadStoredCredentials } from "@botcord/protocol-core";
import type { RoomContextFetcher } from "./room-context.js";

interface CachedClient {
  client: BotCordClient;
  credentialsPath: string;
}

export interface RoomContextFetcherOptions {
  /** agentId → credentials JSON path. Populated by `resolveBootAgents`. */
  credentialPathByAgentId: Map<string, string>;
  /** Default creds path when an agent isn't in the map (rare). */
  defaultCredentialsPath?: string;
  /** Hub base URL override; when set, wins over the URL stored in credentials. */
  hubBaseUrl?: string;
  log?: {
    warn: (msg: string, meta?: Record<string, unknown>) => void;
  };
}

/**
 * Build a {@link RoomContextFetcher} that resolves against Hub. Returns
 * `null` on any error (missing creds, network, non-JSON, etc.) so the
 * system-context builder can skip the block without blocking the turn.
 */
export function createRoomContextFetcher(
  opts: RoomContextFetcherOptions,
): RoomContextFetcher {
  const clients = new Map<string, CachedClient>();

  function getClient(accountId: string): BotCordClient | null {
    const existing = clients.get(accountId);
    if (existing) return existing.client;

    const credsPath =
      opts.credentialPathByAgentId.get(accountId) ?? opts.defaultCredentialsPath;
    if (!credsPath) {
      opts.log?.warn("daemon.room-context.no-credentials", { accountId });
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
      opts.log?.warn("daemon.room-context.client-init-failed", {
        accountId,
        credsPath,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  return async ({ accountId, roomId }) => {
    const client = getClient(accountId);
    if (!client) return null;
    try {
      // Hub returns `{ room_id, name, description, rule, visibility,
      // join_policy, member_count, members: [...], ... }` in a single
      // `/hub/rooms/:id` response. Use the raw value so we don't pay for
      // the typed cast that drops `members`.
      const room = (await client.getRoomInfo(roomId)) as Record<string, unknown>;
      const members = Array.isArray((room as { members?: unknown[] }).members)
        ? ((room as { members: unknown[] }).members as Array<Record<string, unknown>>)
        : [];
      return {
        room: {
          room_id:
            typeof room.room_id === "string" ? room.room_id : roomId,
          ...(typeof room.name === "string" ? { name: room.name } : {}),
          ...(typeof room.description === "string"
            ? { description: room.description }
            : {}),
          ...(typeof room.rule === "string" || room.rule === null
            ? { rule: (room.rule as string | null) ?? null }
            : {}),
          ...(typeof room.visibility === "string"
            ? { visibility: room.visibility }
            : {}),
          ...(typeof room.join_policy === "string"
            ? { join_policy: room.join_policy }
            : {}),
          ...(typeof room.member_count === "number"
            ? { member_count: room.member_count }
            : {}),
        },
        members: members.map((m) => ({
          agent_id: typeof m.agent_id === "string" ? m.agent_id : "unknown",
          ...(typeof m.display_name === "string"
            ? { display_name: m.display_name }
            : {}),
          ...(typeof m.role === "string" ? { role: m.role } : {}),
        })),
      };
    } catch (err) {
      opts.log?.warn("daemon.room-context.fetch-failed", {
        accountId,
        roomId,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  };
}
