/**
 * BotCord ChannelPlugin — defines meta, capabilities, config,
 * outbound (send via signed envelopes), gateway (start websocket/polling),
 * security, messaging, and status adapters.
 */
import type { ChannelPlugin, ClawdbotConfig } from "openclaw/plugin-sdk/core";
import {
  buildBaseChannelStatusSummary,
  createDefaultChannelRuntimeState,
} from "openclaw/plugin-sdk/status-helpers";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-id";
import {
  resolveChannelConfig,
  resolveAccounts,
  isAccountConfigured,
  displayPrefix,
} from "./config.js";
import { BotCordClient } from "./client.js";
import { getBotCordRuntime } from "./runtime.js";
import { startPoller, stopPoller } from "./poller.js";
import { startWsClient, stopWsClient } from "./ws-client.js";
import type {
  BotCordAccountConfig,
  BotCordChannelConfig,
  MessageAttachment,
} from "./types.js";

// ── Types ────────────────────────────────────────────────────────

export interface ResolvedBotCordAccount {
  accountId: string;
  name: string;
  enabled: boolean;
  configured: boolean;
  config: BotCordAccountConfig;
  hubUrl?: string;
  agentId?: string;
  deliveryMode?: "polling" | "websocket";
}

type CoreConfig = any;

// ── Account resolution ───────────────────────────────────────────

function resolveBotCordAccount(params: {
  cfg: CoreConfig;
  accountId?: string | null;
}): ResolvedBotCordAccount {
  const channelCfg = resolveChannelConfig(params.cfg);
  const accounts = resolveAccounts(channelCfg);
  const id = params.accountId || Object.keys(accounts)[0] || "default";
  const acct = accounts[id] || ({} as BotCordAccountConfig);
  const rawDeliveryMode = (acct as { deliveryMode?: string }).deliveryMode;
  const deliveryMode = rawDeliveryMode === "polling" || rawDeliveryMode === "webhook"
    ? "polling"
    : "websocket";

  return {
    accountId: id,
    name: id === "default" ? "BotCord" : `BotCord:${id}`,
    enabled: acct.enabled !== false,
    configured: isAccountConfigured(acct),
    config: acct,
    hubUrl: acct.hubUrl,
    agentId: acct.agentId,
    deliveryMode,
  };
}

function listBotCordAccountIds(cfg: CoreConfig): string[] {
  const channelCfg = resolveChannelConfig(cfg);
  return Object.keys(resolveAccounts(channelCfg));
}

function resolveDefaultAccountId(cfg: CoreConfig): string {
  const ids = listBotCordAccountIds(cfg);
  return ids[0] || "default";
}

// ── Normalize helpers ────────────────────────────────────────────

function normalizeBotCordTarget(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith("ag_") || trimmed.startsWith("rm_")) return trimmed;
  if (trimmed.startsWith("botcord:")) return trimmed.slice("botcord:".length);
  return trimmed;
}

function looksLikeBotCordId(raw: string): boolean {
  const t = raw.trim();
  return t.startsWith("ag_") || t.startsWith("rm_") || t.startsWith("botcord:");
}

// ── Config schema ────────────────────────────────────────────────

const botCordConfigSchema = {
  type: "object" as const,
  additionalProperties: false as const,
  properties: {
    enabled: { type: "boolean" as const },
    credentialsFile: {
      type: "string" as const,
      description: "Path to a BotCord credentials JSON file",
    },
    hubUrl: { type: "string" as const, description: "BotCord Hub URL" },
    agentId: { type: "string" as const, description: "Agent ID (ag_...)" },
    keyId: { type: "string" as const, description: "Key ID for signing" },
    privateKey: { type: "string" as const, description: "Ed25519 private key (base64)" },
    publicKey: { type: "string" as const, description: "Ed25519 public key (base64)" },
    deliveryMode: {
      type: "string" as const,
      enum: ["websocket", "polling"],
    },
    pollIntervalMs: { type: "number" as const },
    allowFrom: {
      type: "array" as const,
      items: { type: "string" as const },
    },
    notifySession: {
      type: "string" as const,
      description: "Session key to notify when inbound messages arrive (e.g. agent:main:main)",
    },
    accounts: {
      type: "object" as const,
      additionalProperties: {
        type: "object" as const,
        properties: {
          enabled: { type: "boolean" as const },
          credentialsFile: { type: "string" as const },
          hubUrl: { type: "string" as const },
          agentId: { type: "string" as const },
          keyId: { type: "string" as const },
          privateKey: { type: "string" as const },
          publicKey: { type: "string" as const },
          deliveryMode: { type: "string" as const, enum: ["websocket", "polling"] },
          pollIntervalMs: { type: "number" as const },
        },
      },
    },
  },
};

// ── Channel Plugin ───────────────────────────────────────────────

export const botCordPlugin: ChannelPlugin<ResolvedBotCordAccount> = {
  id: "botcord",
  meta: {
    id: "botcord",
    label: "BotCord",
    selectionLabel: "BotCord (A2A Protocol)",
    docsPath: "/channels/botcord",
    docsLabel: "botcord",
    blurb: "Secure agent-to-agent messaging via the BotCord A2A protocol (Ed25519 signed envelopes).",
    order: 110,
    quickstartAllowFrom: true,
  },
  capabilities: {
    chatTypes: ["direct", "group"],
    media: true,
    blockStreaming: true,
  },
  reload: { configPrefixes: ["channels.botcord"] },
  configSchema: {
    schema: botCordConfigSchema,
  },
  config: {
    listAccountIds: (cfg) => listBotCordAccountIds(cfg as CoreConfig),
    resolveAccount: (cfg, accountId) =>
      resolveBotCordAccount({ cfg: cfg as CoreConfig, accountId }),
    defaultAccountId: (cfg) => resolveDefaultAccountId(cfg as CoreConfig),
    setAccountEnabled: ({ cfg, accountId, enabled }) => {
      const isDefault = accountId === DEFAULT_ACCOUNT_ID;
      if (isDefault) {
        return {
          ...cfg,
          channels: {
            ...(cfg as any).channels,
            botcord: {
              ...(cfg as any).channels?.botcord,
              enabled,
            },
          },
        };
      }
      const botcordCfg = (cfg as any).channels?.botcord as BotCordChannelConfig | undefined;
      return {
        ...cfg,
        channels: {
          ...(cfg as any).channels,
          botcord: {
            ...botcordCfg,
            accounts: {
              ...botcordCfg?.accounts,
              [accountId]: {
                ...botcordCfg?.accounts?.[accountId],
                enabled,
              },
            },
          },
        },
      };
    },
    deleteAccount: ({ cfg, accountId }) => {
      const isDefault = accountId === DEFAULT_ACCOUNT_ID;
      if (isDefault) {
        const next = { ...cfg } as ClawdbotConfig;
        const nextChannels = { ...(cfg as any).channels };
        delete (nextChannels as Record<string, unknown>).botcord;
        if (Object.keys(nextChannels).length > 0) {
          next.channels = nextChannels;
        } else {
          delete next.channels;
        }
        return next;
      }
      const botcordCfg = (cfg as any).channels?.botcord as BotCordChannelConfig | undefined;
      const accounts = { ...botcordCfg?.accounts };
      delete accounts[accountId];
      return {
        ...cfg,
        channels: {
          ...(cfg as any).channels,
          botcord: {
            ...botcordCfg,
            accounts: Object.keys(accounts).length > 0 ? accounts : undefined,
          },
        },
      };
    },
    isConfigured: (account) => account.configured,
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      hubUrl: account.hubUrl,
      agentId: account.agentId,
      deliveryMode: account.deliveryMode,
    }),
    resolveAllowFrom: ({ cfg, accountId }) => {
      const account = resolveBotCordAccount({ cfg: cfg as CoreConfig, accountId });
      return (account.config.allowFrom ?? []).map((entry) => String(entry));
    },
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom
        .map((entry) => String(entry).trim())
        .filter(Boolean)
        .map((entry) => entry.replace(/^botcord:/i, "").toLowerCase()),
  },
  security: {
    collectWarnings: ({ cfg, accountId }) => {
      const account = resolveBotCordAccount({ cfg: cfg as CoreConfig, accountId });
      const warnings: string[] = [];
      if (!account.config.privateKey) {
        warnings.push(
          "- BotCord private key is not configured; messages cannot be signed.",
        );
      }
      return warnings;
    },
  },
  messaging: {
    normalizeTarget: (raw) => normalizeBotCordTarget(raw),
    targetResolver: {
      looksLikeId: looksLikeBotCordId,
      hint: "<ag_id|rm_id>",
    },
  },
  resolver: {
    resolveTargets: async ({ inputs, kind }) => {
      return inputs.map((input) => {
        const normalized = normalizeBotCordTarget(input);
        if (!normalized) {
          return { input, resolved: false, note: "invalid BotCord target" };
        }
        if (kind === "group" && !normalized.startsWith("rm_")) {
          return { input, resolved: false, note: "expected room target (rm_...)" };
        }
        return {
          input,
          resolved: true,
          id: normalized,
          name: normalized,
        };
      });
    },
  },
  directory: {
    self: async ({ cfg, accountId }) => {
      const account = resolveBotCordAccount({ cfg: cfg as CoreConfig, accountId });
      if (!account.configured || !account.agentId) return null;
      try {
        const client = new BotCordClient(account.config);
        const info = await client.resolve(account.agentId);
        return { kind: "user", id: info.agent_id, name: info.display_name || info.agent_id };
      } catch {
        return { kind: "user", id: account.agentId, name: account.agentId };
      }
    },
    listPeers: async ({ cfg, accountId, query, limit }) => {
      const account = resolveBotCordAccount({ cfg: cfg as CoreConfig, accountId });
      if (!account.configured) return [];
      try {
        const client = new BotCordClient(account.config);
        const contacts = await client.listContacts();
        const q = query?.trim().toLowerCase() ?? "";
        return contacts
          .filter(
            (c) =>
              !q ||
              c.contact_agent_id.toLowerCase().includes(q) ||
              c.display_name?.toLowerCase().includes(q),
          )
          .slice(0, limit && limit > 0 ? limit : undefined)
          .map((c) => ({
            kind: "user" as const,
            id: c.contact_agent_id,
            name: c.display_name || c.contact_agent_id,
          }));
      } catch {
        return [];
      }
    },
    listGroups: async ({ cfg, accountId, query, limit }) => {
      const account = resolveBotCordAccount({ cfg: cfg as CoreConfig, accountId });
      if (!account.configured) return [];
      try {
        const client = new BotCordClient(account.config);
        const rooms = await client.listMyRooms();
        const q = query?.trim().toLowerCase() ?? "";
        return rooms
          .filter((r) => !q || r.room_id.toLowerCase().includes(q) || r.name?.toLowerCase().includes(q))
          .slice(0, limit && limit > 0 ? limit : undefined)
          .map((r) => ({ kind: "group" as const, id: r.room_id, name: r.name || r.room_id }));
      } catch {
        return [];
      }
    },
  },
  outbound: {
    deliveryMode: "direct",
    chunker: (text, limit) => getBotCordRuntime().channel.text.chunkMarkdownText(text, limit),
    chunkerMode: "markdown",
    textChunkLimit: 4000,
    sendText: async ({ cfg, to, text, accountId }) => {
      const account = resolveBotCordAccount({ cfg: cfg as CoreConfig, accountId: accountId ?? undefined });
      const client = new BotCordClient(account.config);
      const result = await client.sendMessage(to, text);
      return {
        channel: "botcord",
        ok: true,
        messageId: result.hub_msg_id,
      };
    },
    sendMedia: async ({ cfg, to, text, mediaUrl, accountId }) => {
      const account = resolveBotCordAccount({ cfg: cfg as CoreConfig, accountId: accountId ?? undefined });
      const client = new BotCordClient(account.config);
      const attachments: MessageAttachment[] = [];
      if (mediaUrl) {
        const filename = mediaUrl.split("/").pop() || "attachment";
        attachments.push({ filename, url: mediaUrl });
      }
      const result = await client.sendMessage(to, text, {
        attachments: attachments.length > 0 ? attachments : undefined,
      });
      return {
        channel: "botcord",
        ok: true,
        messageId: result.hub_msg_id,
      };
    },
  },
  status: {
    defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID),
    buildChannelSummary: ({ snapshot }) => ({
      ...buildBaseChannelStatusSummary(snapshot),
    }),
    buildAccountSnapshot: ({ account, runtime }) => ({
      accountId: account.accountId,
      enabled: account.enabled,
      configured: account.configured,
      name: account.name,
      hubUrl: account.hubUrl,
      agentId: account.agentId,
      deliveryMode: account.deliveryMode,
      running: runtime?.running ?? false,
      lastStartAt: runtime?.lastStartAt ?? null,
      lastStopAt: runtime?.lastStopAt ?? null,
      lastError: runtime?.lastError ?? null,
    }),
  },
  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      if (!account.configured) {
        throw new Error(
          `BotCord is not configured for account "${account.accountId}" (need hubUrl, agentId, keyId, privateKey).`,
        );
      }

      const dp = displayPrefix(account.accountId, ctx.cfg);
      ctx.log?.info(`[${dp}] starting BotCord gateway (${account.deliveryMode} mode)`);

      const client = new BotCordClient(account.config);
      const mode = account.deliveryMode || "websocket";

      if (mode === "websocket") {
        ctx.log?.info(`[${dp}] starting WebSocket connection to Hub`);
        startWsClient({
          client,
          accountId: account.accountId,
          cfg: ctx.cfg,
          abortSignal: ctx.abortSignal,
          log: ctx.log,
        });
      } else {
        startPoller({
          client,
          accountId: account.accountId,
          cfg: ctx.cfg,
          intervalMs: account.config.pollIntervalMs || 5000,
          abortSignal: ctx.abortSignal,
          log: ctx.log,
        });
      }

      ctx.setStatus({ accountId: ctx.accountId, running: true, lastStartAt: Date.now() });

      // Keep the promise alive until the gateway signals shutdown via abortSignal.
      // If we return immediately, the gateway considers the channel "stopped" and
      // enters an auto-restart loop.
      await new Promise<void>((resolve) => {
        if (ctx.abortSignal?.aborted) {
          resolve();
          return;
        }
        ctx.abortSignal?.addEventListener("abort", () => resolve(), { once: true });
      });

      stopWsClient(account.accountId);
      stopPoller(account.accountId);
      ctx.setStatus({ accountId: ctx.accountId, running: false, lastStopAt: Date.now() });
    },
  },
};
