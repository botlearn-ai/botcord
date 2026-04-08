import { describe, expect, it, vi } from "vitest";
import plugin from "../../index.js";

describe("botcord plugin hooks", () => {
  it("registers hooks and context engine", () => {
    const on = vi.fn();
    const registerContextEngine = vi.fn();

    plugin.register?.({
      id: "botcord",
      name: "BotCord",
      description: "BotCord",
      source: "test",
      registrationMode: "full" as const,
      config: {},
      runtime: {} as never,
      logger: {
        info() {},
        warn() {},
        error() {},
      },
      registerTool() {},
      registerHook() {},
      registerHttpRoute() {},
      registerChannel() {},
      registerGatewayMethod() {},
      registerCli() {},
      registerService() {},
      registerProvider() {},
      registerCommand() {},
      registerContextEngine,
      registerSpeechProvider() {},
      registerMediaUnderstandingProvider() {},
      registerImageGenerationProvider() {},
      registerWebSearchProvider() {},
      registerInteractiveHandler() {},
      registerConversationBinding() {},
      registerShutdownHook() {},
      resolvePath(input: string) {
        return input;
      },
      on,
    } as any);

    // Hook registrations: after_tool_call, two before_prompt_build hooks
    // (static room context + dynamic context), session_end.
    // All dynamic context (cross-room digest, working memory, loop-risk)
    // now uses appendSystemContext instead of prependContext.
    expect(on.mock.calls.map((call) => call[0])).toEqual([
      "after_tool_call",
      "before_prompt_build", // static room context (appendSystemContext)
      "before_prompt_build", // dynamic context (appendSystemContext)
      "session_end",
    ]);
  });
});
