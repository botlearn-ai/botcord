// Re-export all protocol types from shared package
export * from "@botcord/protocol-core";

// Plugin-specific types (not shared)
// Account config in openclaw.json channels.botcord
export type BotCordAccountConfig = {
  enabled?: boolean;
  credentialsFile?: string;
  hubUrl?: string;
  agentId?: string;
  keyId?: string;
  privateKey?: string;
  publicKey?: string;
  token?: string;
  tokenExpiresAt?: number;
  deliveryMode?: "polling" | "websocket";
  pollIntervalMs?: number;
  allowFrom?: string[];
  notifySession?: string | string[];
  accounts?: Record<string, BotCordAccountConfig>;
};

export type BotCordChannelConfig = BotCordAccountConfig;
