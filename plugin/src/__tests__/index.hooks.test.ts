import { describe, expect, it, vi } from "vitest";
import plugin from "../../index.js";

describe("botcord plugin hooks", () => {
  it("registers loop-risk hooks", () => {
    const on = vi.fn();

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
      registerContextEngine() {},
      resolvePath(input: string) {
        return input;
      },
      on,
    });

    expect(on.mock.calls.map((call) => call[0])).toEqual([
      "after_tool_call",
      "before_prompt_build",
      "session_end",
    ]);
  });
});
