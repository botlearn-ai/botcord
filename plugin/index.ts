/**
 * @botcord/botcord — OpenClaw plugin for BotCord A2A messaging protocol.
 */
import { botCordPlugin } from "./src/channel.js";
import { setBotCordRuntime, setConfigGetter } from "./src/runtime.js";
import { createMessagingTool, createUploadTool } from "./src/tools/messaging.js";
import { createRoomsTool } from "./src/tools/rooms.js";
import { createContactsTool } from "./src/tools/contacts.js";
import { createDirectoryTool } from "./src/tools/directory.js";
import { createTopicsTool } from "./src/tools/topics.js";
import { createAccountTool } from "./src/tools/account.js";
import { createPaymentTool } from "./src/tools/payment.js";
import { createSubscriptionTool } from "./src/tools/subscription.js";
import { createNotifyTool } from "./src/tools/notify.js";
import { createBindTool } from "./src/tools/bind.js";
import { createRegisterTool } from "./src/tools/register.js";
import { createResetCredentialTool } from "./src/tools/reset-credential.js";
import { createHealthcheckCommand } from "./src/commands/healthcheck.js";
import { createTokenCommand } from "./src/commands/token.js";
import { createBindCommand } from "./src/commands/bind.js";
import { createEnvCommand } from "./src/commands/env.js";
import { createResetCredentialCommand } from "./src/commands/reset-credential.js";
import {
  buildBotCordLoopRiskPrompt,
  clearBotCordLoopRiskSession,
  didBotCordSendSucceed,
  recordBotCordOutboundText,
  shouldRunBotCordLoopRiskCheck,
} from "./src/loop-risk.js";
import { buildRoomContextHookResult, clearSessionRoom } from "./src/room-context.js";

// Inline replacement for defineChannelPluginEntry from openclaw/plugin-sdk/core.
// Avoids missing dist artifacts in npm-installed openclaw (see openclaw#53685).
export default {
  id: "botcord",
  name: "BotCord",
  description: "BotCord A2A messaging protocol — secure agent-to-agent communication with Ed25519 signing",
  register(api: any) {
    setBotCordRuntime(api.runtime);
    api.registerChannel({ plugin: botCordPlugin });

    if (api.registrationMode !== "full") return;

    setConfigGetter(() => api.config);

    // Agent tools — `as any` needed until tool execute() return types are
    // migrated to the AgentToolResult<T> shape (P2 task).
    api.registerTool(createMessagingTool() as any);
    api.registerTool(createUploadTool() as any);
    api.registerTool(createRoomsTool() as any);
    api.registerTool(createTopicsTool() as any);
    api.registerTool(createContactsTool() as any);
    api.registerTool(createAccountTool() as any);
    api.registerTool(createDirectoryTool() as any);
    api.registerTool(createPaymentTool() as any);
    api.registerTool(createSubscriptionTool() as any);
    api.registerTool(createNotifyTool() as any);
    api.registerTool(createBindTool() as any);
    api.registerTool(createRegisterTool() as any);
    api.registerTool(createResetCredentialTool() as any);

    // Hooks
    api.on("after_tool_call", async (event: any, ctx: any) => {
      if (ctx.toolName !== "botcord_send") return;
      if (!didBotCordSendSucceed(event.result, event.error)) return;
      recordBotCordOutboundText({
        sessionKey: ctx.sessionKey,
        text: event.params.text,
      });
    });

    // Room context injection — higher priority = runs first, so its
    // prependContext is placed farther from the user prompt.
    api.on("before_prompt_build", async (_event: any, ctx: any) => {
      return buildRoomContextHookResult(ctx.sessionKey);
    }, { priority: 50 });

    // Loop-risk guard — lower priority = runs later, so its prependContext
    // ends up closest to the user prompt where it's most effective.
    api.on("before_prompt_build", async (event: any, ctx: any) => {
      if (!shouldRunBotCordLoopRiskCheck({
        channelId: ctx.channelId,
        prompt: event.prompt,
        trigger: ctx.trigger,
      })) {
        return;
      }

      const prependContext = buildBotCordLoopRiskPrompt({
        prompt: event.prompt,
        messages: event.messages,
        sessionKey: ctx.sessionKey,
      });

      if (!prependContext) return;
      return { prependContext };
    }, { priority: 50 });

    api.on("session_end", async (_event: any, ctx: any) => {
      clearBotCordLoopRiskSession(ctx.sessionKey);
      clearSessionRoom(ctx.sessionKey);
    });

    // Commands
    api.registerCommand(createHealthcheckCommand());
    api.registerCommand(createTokenCommand());
    api.registerCommand(createBindCommand());
    api.registerCommand(createResetCredentialCommand());
    api.registerCommand(createEnvCommand());

  },
};

export { TopicTracker } from "./src/topic-tracker.js";
export type { TopicState, TopicInfo } from "./src/topic-tracker.js";
