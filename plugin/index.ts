/**
 * @botcord/botcord — OpenClaw plugin for BotCord A2A messaging protocol.
 */
import { botCordPlugin } from "./src/channel.js";
import { setBotCordRuntime, setConfigGetter } from "./src/runtime.js";
import { createMessagingTool, createUploadTool } from "./src/tools/messaging.js";
import { createRoomsTool } from "./src/tools/rooms.js";
import { createContactsTool } from "./src/tools/contacts.js";
import { createDirectoryTool } from "./src/tools/directory.js";
import { createRoomContextTool } from "./src/tools/room-context.js";
import { createTopicsTool } from "./src/tools/topics.js";
import { createAccountTool } from "./src/tools/account.js";
import { createPaymentTool } from "./src/tools/payment.js";
import { createSubscriptionTool } from "./src/tools/subscription.js";
import { createNotifyTool } from "./src/tools/notify.js";
import { createBindTool } from "./src/tools/bind.js";
import { createRegisterTool } from "./src/tools/register.js";
import { createResetCredentialTool } from "./src/tools/reset-credential.js";
import { createWorkingMemoryTool } from "./src/tools/working-memory.js";
import { createApiTool } from "./src/tools/api.js";
import { createHealthcheckCommand } from "./src/commands/healthcheck.js";
import { createTokenCommand } from "./src/commands/token.js";
import { createBindCommand } from "./src/commands/bind.js";
import { createEnvCommand } from "./src/commands/env.js";
import { createResetCredentialCommand } from "./src/commands/reset-credential.js";
import { createRegisterCli } from "./src/commands/register.js";
import { createUninstallCli } from "./src/commands/uninstall.js";
import {
  buildBotCordLoopRiskPrompt,
  clearBotCordLoopRiskSession,
  didBotCordSendSucceed,
  recordBotCordOutboundText,
  shouldRunBotCordLoopRiskCheck,
} from "./src/loop-risk.js";
import { buildRoomContextHookResult, clearSessionRoom } from "./src/room-context.js";
import { activeOwnerChatStreams } from "./src/owner-chat-stream.js";
import { buildWorkingMemoryHookResult } from "./src/memory-hook.js";

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

    // Agent tools (14 total)
    api.registerTool(createMessagingTool() as any);
    api.registerTool(createUploadTool() as any);
    api.registerTool(createRoomsTool() as any);
    api.registerTool(createTopicsTool() as any);
    api.registerTool(createContactsTool() as any);
    api.registerTool(createAccountTool() as any);
    api.registerTool(createDirectoryTool() as any);
    api.registerTool(createRoomContextTool() as any);
    api.registerTool(createPaymentTool() as any);
    api.registerTool(createSubscriptionTool() as any);
    api.registerTool(createNotifyTool() as any);
    api.registerTool(createBindTool() as any);
    api.registerTool(createRegisterTool() as any);
    api.registerTool(createResetCredentialTool() as any);
    api.registerTool(createWorkingMemoryTool() as any);
    api.registerTool(createApiTool() as any);

    // Hooks
    api.on("after_tool_call", async (event: any, ctx: any) => {
      // Stream tool blocks to Hub for active owner-chat sessions
      const stream = activeOwnerChatStreams.get(ctx.sessionKey);
      if (stream) {
        try {
          const toolName = ctx.toolName ?? "unknown";
          const paramsSummary: Record<string, unknown> = {};
          if (event.params && typeof event.params === "object") {
            // Redact working memory content — it should stay local
            const redactKeys = toolName === "botcord_update_working_memory"
              ? new Set(["content"])
              : new Set<string>();
            for (const [k, v] of Object.entries(event.params)) {
              if (redactKeys.has(k)) {
                paramsSummary[k] = "[redacted]";
              } else {
                paramsSummary[k] = typeof v === "string" && v.length > 200
                  ? v.slice(0, 200) + "..."
                  : v;
              }
            }
          }
          await stream.client.postStreamBlock(stream.traceId, stream.seq++, {
            kind: "tool_call",
            payload: { name: toolName, params: paramsSummary },
          });

          if (event.result != null) {
            const resultStr = typeof event.result === "string"
              ? event.result
              : JSON.stringify(event.result);
            await stream.client.postStreamBlock(stream.traceId, stream.seq++, {
              kind: "tool_result",
              payload: {
                name: toolName,
                result: resultStr.length > 500 ? resultStr.slice(0, 500) + "..." : resultStr,
              },
            });
          }
        } catch (err) {
          console.warn("[botcord] owner-chat stream block error:", err);
        }
      }

      // Existing loop-risk tracking
      if (ctx.toolName !== "botcord_send") return;
      if (!didBotCordSendSucceed(event.result, event.error)) return;
      recordBotCordOutboundText({
        sessionKey: ctx.sessionKey,
        text: event.params.text,
      });
    });

    // Room context injection — highest priority among BotCord hooks, so its
    // prependContext is placed farther from the user prompt.
    api.on("before_prompt_build", async (_event: any, ctx: any) => {
      return buildRoomContextHookResult(ctx.sessionKey);
    }, { priority: 60 });

    // Working memory injection — between room context and loop-risk.
    api.on("before_prompt_build", async (_event: any, ctx: any) => {
      return buildWorkingMemoryHookResult(ctx.sessionKey);
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

    // CLI
    const registerCli = createRegisterCli();
    api.registerCli(registerCli.setup, { commands: registerCli.commands });
    const uninstallCli = createUninstallCli();
    api.registerCli(uninstallCli.setup, { commands: uninstallCli.commands });
  },
};

export { TopicTracker } from "./src/topic-tracker.js";
export type { TopicState, TopicInfo } from "./src/topic-tracker.js";
