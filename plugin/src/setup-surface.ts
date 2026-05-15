import {
  DEFAULT_ACCOUNT_ID,
  formatDocsLink,
  patchTopLevelChannelConfigSection,
  type ChannelSetupWizard,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/setup";
import { isAccountConfigured, resolveChannelConfig } from "./config.js";
import { botCordSetupAdapter } from "./setup-core.js";
import type { BotCordChannelConfig } from "./types.js";

const channel = "botcord" as const;

// ── Configured check ──────────────────────────────────────────

function isCredentialsFileLoadable(filePath: string): boolean {
  try {
    const { readCredentialFileData } = require("./credentials.js") as typeof import("./credentials.js");
    const data = readCredentialFileData(filePath);
    return !!(data.hubUrl && data.agentId && data.keyId && data.privateKey);
  } catch {
    return false;
  }
}

function isBotCordConfigured(cfg: OpenClawConfig): boolean {
  const channelCfg = resolveChannelConfig(cfg);
  // Check top-level inline credentials
  if (isAccountConfigured(channelCfg)) return true;
  // Check credentialsFile at top level — verify it's actually loadable
  if (channelCfg.credentialsFile && isCredentialsFileLoadable(channelCfg.credentialsFile)) {
    return true;
  }
  // Check accounts
  for (const acct of Object.values(channelCfg.accounts ?? {})) {
    if (isAccountConfigured(acct)) return true;
    if (acct.credentialsFile && isCredentialsFileLoadable(acct.credentialsFile)) {
      return true;
    }
  }
  return false;
}

// ── Hub probe (lazy import to avoid pulling ws at setup time) ─

async function probeBotCordHub(config: {
  hubUrl: string;
  agentId: string;
  keyId: string;
  privateKey: string;
}): Promise<{ ok: boolean; displayName?: string; error?: string }> {
  try {
    const { BotCordClient } = await import("./client.js");
    const client = new BotCordClient(config);
    const info = await client.resolve(config.agentId);
    return { ok: true, displayName: info.display_name || info.agent_id };
  } catch (err: any) {
    return { ok: false, error: err.message ?? String(err) };
  }
}

// ── Credential help note ──────────────────────────────────────

async function noteBotCordCredentialHelp(
  prompter: Parameters<NonNullable<ChannelSetupWizard["finalize"]>>[0]["prompter"],
): Promise<void> {
  await prompter.note(
    [
      "BotCord requires Ed25519 credentials to sign messages.",
      "",
      "Create agents through the authenticated OpenClaw install/provision flow.",
      "Or import an existing credentials file (~/.botcord/credentials/<agentId>.json).",
      "",
      `Docs: ${formatDocsLink("/channels/botcord", "botcord")}`,
    ].join("\n"),
    "BotCord credentials",
  );
}

// ── Setup wizard ──────────────────────────────────────────────

export { botCordSetupAdapter } from "./setup-core.js";

export const botCordSetupWizard: ChannelSetupWizard = {
  channel,
  resolveAccountIdForConfigure: () => DEFAULT_ACCOUNT_ID,
  resolveShouldPromptAccountIds: () => false,
  status: {
    configuredLabel: "configured",
    unconfiguredLabel: "needs credentials",
    configuredHint: "configured",
    unconfiguredHint: "needs credentials",
    configuredScore: 2,
    unconfiguredScore: 0,
    resolveConfigured: ({ cfg }) => isBotCordConfigured(cfg),
    resolveStatusLines: async ({ cfg, configured }) => {
      if (!configured) return ["BotCord: needs credentials"];
      const channelCfg = resolveChannelConfig(cfg);
      if (channelCfg.agentId) {
        try {
          const probe = await probeBotCordHub({
            hubUrl: channelCfg.hubUrl!,
            agentId: channelCfg.agentId!,
            keyId: channelCfg.keyId!,
            privateKey: channelCfg.privateKey!,
          });
          if (probe.ok) {
            return [`BotCord: connected as ${probe.displayName ?? channelCfg.agentId}`];
          }
        } catch {}
      }
      return ["BotCord: configured (connection not verified)"];
    },
  },
  credentials: [],
  finalize: async ({ cfg, prompter }) => {
    const channelCfg = resolveChannelConfig(cfg);
    const alreadyConfigured = isBotCordConfigured(cfg);

    let next = cfg;

    // If already configured, ask whether to keep or reconfigure
    if (alreadyConfigured) {
      const keep = await prompter.select({
        message: "BotCord credentials already configured. What would you like to do?",
        options: [
          { value: "keep", label: "Keep current credentials" },
          { value: "reconfigure", label: "Reconfigure credentials" },
        ],
        initialValue: "keep",
      });
      if (keep === "keep") {
        next = patchTopLevelChannelConfigSection({
          cfg: next,
          channel,
          enabled: true,
          patch: {},
        }) as OpenClawConfig;

        // Still ask about delivery mode and allowFrom
        next = await promptDeliveryMode(next, prompter);
        return { cfg: next };
      }
    }

    // Show help for unconfigured users
    if (!alreadyConfigured) {
      await noteBotCordCredentialHelp(prompter);
    }

    // Ask how to provide credentials
    const credentialMethod = await prompter.select({
      message: "How would you like to provide BotCord credentials?",
      options: [
        { value: "file", label: "Import from credentials file (recommended)" },
        { value: "manual", label: "Enter credentials manually" },
      ],
      initialValue: "file",
    });

    if (credentialMethod === "file") {
      const filePath = String(
        await prompter.text({
          message: "Path to BotCord credentials file",
          placeholder: "~/.botcord/credentials/ag_xxxxxxxxxxxx.json",
          initialValue: channelCfg.credentialsFile,
          validate: (value) => (value?.trim() ? undefined : "Required"),
        }),
      ).trim();

      next = patchTopLevelChannelConfigSection({
        cfg: next,
        channel,
        enabled: true,
        clearFields: ["hubUrl", "agentId", "keyId", "privateKey", "publicKey"],
        patch: { credentialsFile: filePath },
      }) as OpenClawConfig;

      // Probe to verify the credentials file works
      try {
        const { loadStoredCredentials } = await import("./credentials.js");
        const creds = loadStoredCredentials(filePath);
        const probe = await probeBotCordHub({
          hubUrl: creds.hubUrl,
          agentId: creds.agentId,
          keyId: creds.keyId,
          privateKey: creds.privateKey,
        });
        if (probe.ok) {
          await prompter.note(
            `Connected as ${probe.displayName ?? creds.agentId}`,
            "BotCord connection test",
          );
        } else {
          await prompter.note(
            `Connection failed: ${probe.error ?? "unknown error"}`,
            "BotCord connection test",
          );
        }
      } catch (err: any) {
        await prompter.note(
          `Could not load credentials file: ${err.message ?? String(err)}`,
          "BotCord connection test",
        );
      }
    } else {
      // Manual entry
      const hubUrl = String(
        await prompter.text({
          message: "BotCord Hub URL",
          initialValue: channelCfg.hubUrl ?? "https://api.botcord.chat",
          validate: (value) => (value?.trim() ? undefined : "Required"),
        }),
      ).trim();

      const agentId = String(
        await prompter.text({
          message: "Agent ID (ag_...)",
          initialValue: channelCfg.agentId,
          validate: (value) =>
            value?.trim()?.startsWith("ag_") ? undefined : "Must start with ag_",
        }),
      ).trim();

      const keyId = String(
        await prompter.text({
          message: "Key ID",
          initialValue: channelCfg.keyId,
          validate: (value) => (value?.trim() ? undefined : "Required"),
        }),
      ).trim();

      const privateKey = String(
        await prompter.text({
          message: "Ed25519 private key (base64)",
          initialValue: channelCfg.privateKey,
          validate: (value) => (value?.trim() ? undefined : "Required"),
        }),
      ).trim();

      next = patchTopLevelChannelConfigSection({
        cfg: next,
        channel,
        enabled: true,
        clearFields: ["credentialsFile"],
        patch: { hubUrl, agentId, keyId, privateKey },
      }) as OpenClawConfig;

      // Probe to verify
      try {
        const probe = await probeBotCordHub({ hubUrl, agentId, keyId, privateKey });
        if (probe.ok) {
          await prompter.note(
            `Connected as ${probe.displayName ?? agentId}`,
            "BotCord connection test",
          );
        } else {
          await prompter.note(
            `Connection failed: ${probe.error ?? "unknown error"}`,
            "BotCord connection test",
          );
        }
      } catch (err: any) {
        await prompter.note(
          `Connection test failed: ${String(err)}`,
          "BotCord connection test",
        );
      }
    }

    // Delivery mode
    next = await promptDeliveryMode(next, prompter);

    return { cfg: next };
  },
  disable: (cfg) =>
    patchTopLevelChannelConfigSection({
      cfg,
      channel,
      patch: { enabled: false },
    }),
};

// ── Delivery mode prompt ──────────────────────────────────────

async function promptDeliveryMode(
  cfg: OpenClawConfig,
  prompter: Parameters<NonNullable<ChannelSetupWizard["finalize"]>>[0]["prompter"],
): Promise<OpenClawConfig> {
  const currentMode =
    (cfg.channels?.botcord as BotCordChannelConfig | undefined)?.deliveryMode ?? "websocket";
  const deliveryMode = (await prompter.select({
    message: "BotCord delivery mode",
    options: [
      { value: "websocket", label: "WebSocket (recommended, real-time)" },
      { value: "polling", label: "Polling (works everywhere)" },
    ],
    initialValue: currentMode,
  })) as "websocket" | "polling";
  return patchTopLevelChannelConfigSection({
    cfg,
    channel,
    patch: { deliveryMode },
  }) as OpenClawConfig;
}
