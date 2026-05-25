import {
  BotCordClient,
  defaultCredentialsFile,
  loadStoredCredentials,
  updateCredentialsToken,
} from "@botcord/protocol-core";
import type { DaemonAttentionPolicy } from "./gateway/policy-resolver.js";

interface CachedClient {
  client: BotCordClient;
  credentialsPath: string;
}

export interface AttentionPolicyFetcherOptions {
  credentialPathByAgentId: Map<string, string>;
  defaultCredentialsPath?: string;
  hubBaseUrl?: string;
  log?: {
    warn: (msg: string, meta?: Record<string, unknown>) => void;
  };
}

export type AttentionPolicyFetcher = (args: {
  agentId: string;
  roomId?: string | null;
}) => Promise<DaemonAttentionPolicy | undefined>;

export function createAttentionPolicyFetcher(
  opts: AttentionPolicyFetcherOptions,
): AttentionPolicyFetcher {
  const clients = new Map<string, CachedClient>();

  function getClient(agentId: string): BotCordClient | null {
    const existing = clients.get(agentId);
    if (existing) return existing.client;

    const credentialsPath =
      opts.credentialPathByAgentId.get(agentId) ??
      opts.defaultCredentialsPath ??
      defaultCredentialsFile(agentId);

    try {
      const creds = loadStoredCredentials(credentialsPath);
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
      client.onTokenRefresh = (token, expiresAt) => {
        try {
          updateCredentialsToken(credentialsPath, token, expiresAt);
        } catch {
          // Persistence failures are non-fatal; the next refresh retries.
        }
      };
      clients.set(agentId, { client, credentialsPath });
      return client;
    } catch (err) {
      opts.log?.warn("daemon.attention-policy.client-init-failed", {
        agentId,
        credentialsPath,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  return async ({ agentId, roomId }) => {
    const client = getClient(agentId);
    if (!client) return undefined;
    try {
      return await client.getAttentionPolicy({ roomId });
    } catch (err) {
      opts.log?.warn("daemon.attention-policy.fetch-failed", {
        agentId,
        roomId: roomId ?? null,
        error: err instanceof Error ? err.message : String(err),
      });
      return undefined;
    }
  };
}
