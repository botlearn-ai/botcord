/**
 * botcord_plugin — OpenClaw plugin for BotCord A2A messaging protocol.
 *
 * Registers:
 * - Channel plugin (botcord) with WebSocket + polling gateway
 * - Agent tools: botcord_send, botcord_upload, botcord_rooms, botcord_topics, botcord_contacts, botcord_account, botcord_directory, botcord_wallet, botcord_subscription
 * - Commands: /botcord_healthcheck, /botcord_token
 * - CLI: openclaw botcord-register, openclaw botcord-import, openclaw botcord-export
 */
import type { ChannelPlugin, OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { botCordPlugin } from "./src/channel.js";
import { setBotCordRuntime, setConfigGetter } from "./src/runtime.js";
import { createMessagingTool, createUploadTool } from "./src/tools/messaging.js";
import { createRoomsTool } from "./src/tools/rooms.js";
import { createContactsTool } from "./src/tools/contacts.js";
import { createDirectoryTool } from "./src/tools/directory.js";
import { createTopicsTool } from "./src/tools/topics.js";
import { createAccountTool } from "./src/tools/account.js";
import { createWalletTool } from "./src/tools/wallet.js";
import { createSubscriptionTool } from "./src/tools/subscription.js";
import { createNotifyTool } from "./src/tools/notify.js";
import { createHealthcheckCommand } from "./src/commands/healthcheck.js";
import { createTokenCommand } from "./src/commands/token.js";
import { createRegisterCli } from "./src/commands/register.js";

const plugin = {
  id: "botcord",
  name: "BotCord",
  description: "BotCord A2A messaging protocol — secure agent-to-agent communication with Ed25519 signing",
  configSchema: emptyPluginConfigSchema(),

  register(api: OpenClawPluginApi) {
    // Store runtime reference and config getter
    setBotCordRuntime(api.runtime);
    setConfigGetter(() => api.config);

    // Register channel plugin
    api.registerChannel({ plugin: botCordPlugin as ChannelPlugin });

    // Register agent tools
    api.registerTool(createMessagingTool() as any);
    api.registerTool(createRoomsTool() as any);
    api.registerTool(createTopicsTool() as any);
    api.registerTool(createContactsTool() as any);
    api.registerTool(createAccountTool() as any);
    api.registerTool(createDirectoryTool() as any);
    api.registerTool(createUploadTool() as any);
    api.registerTool(createWalletTool() as any);
    api.registerTool(createSubscriptionTool() as any);
    api.registerTool(createNotifyTool() as any);

    // Register commands
    api.registerCommand(createHealthcheckCommand() as any);
    api.registerCommand(createTokenCommand() as any);

    // Register CLI command
    const registerCli = createRegisterCli();
    api.registerCli(registerCli.setup, { commands: registerCli.commands });
  },
};

export { TopicTracker } from "./src/topic-tracker.js";
export type { TopicState, TopicInfo } from "./src/topic-tracker.js";

export default plugin;
