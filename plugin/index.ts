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
import { createHealthcheckCommand } from "./src/commands/healthcheck.js";
import { createTokenCommand } from "./src/commands/token.js";
import { createBindCommand } from "./src/commands/bind.js";
import { createEnvCommand } from "./src/commands/env.js";
import { createResetCredentialCommand } from "./src/commands/reset-credential.js";
import { createUninstallCli } from "./src/commands/uninstall.js";
import {
  clearBotCordLoopRiskSession,
  didBotCordSendSucceed,
  recordBotCordOutboundText,
} from "./src/loop-risk.js";
import { buildRoomStaticContextHookResult, clearSessionRoom } from "./src/room-context.js";
import { activeOwnerChatStreams } from "./src/owner-chat-stream.js";
import { buildDynamicContext } from "./src/dynamic-context.js";
import { buildOnboardingHookResult } from "./src/onboarding-hook.js";

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
    api.registerTool(createRoomContextTool() as any);
    api.registerTool(createPaymentTool() as any);
    api.registerTool(createSubscriptionTool() as any);
    api.registerTool(createNotifyTool() as any);
    api.registerTool(createBindTool() as any);
    api.registerTool(createRegisterTool() as any);
    api.registerTool(createResetCredentialTool() as any);
    api.registerTool(createWorkingMemoryTool() as any);

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

    // Room context + dynamic context injection — all via appendSystemContext.
    // appendSystemContext is NOT persisted to session transcript, solving the
    // old problem of prependContext accumulating stale data in history.
    //
    // Two hooks at different priorities:
    // 1. Static room context (priority 60, cacheable): room metadata
    // 2. Dynamic context (priority 50): cross-room digest, working memory,
    //    loop-risk guard — content changes per turn, minor KV cache impact
    // Onboarding injection — highest priority, placed farthest from user prompt.
    // Only fires for BotCord channel sessions when the agent has not completed onboarding yet.
    api.on("before_prompt_build", async (_event: any, ctx: any) => {
      if (ctx.channelId !== "botcord") return null;
      return buildOnboardingHookResult();
    }, { priority: 70 });

    api.on("before_prompt_build", async (_event: any, ctx: any) => {
      return buildRoomStaticContextHookResult(ctx.sessionKey);
    }, { priority: 60 });

    api.on("before_prompt_build", async (event: any, ctx: any) => {
      if (!ctx.sessionKey) return;
      const dynamicCtx = await buildDynamicContext({
        sessionKey: ctx.sessionKey,
        channelId: ctx.channelId,
        prompt: event.prompt,
        messages: event.messages,
        trigger: ctx.trigger,
      });
      if (!dynamicCtx) return;
      return { appendSystemContext: dynamicCtx };
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

    const uninstallCli = createUninstallCli();
    api.registerCli(uninstallCli.setup, { commands: uninstallCli.commands });

  },
};

export { TopicTracker } from "./src/topic-tracker.js";
export type { TopicState, TopicInfo } from "./src/topic-tracker.js";
