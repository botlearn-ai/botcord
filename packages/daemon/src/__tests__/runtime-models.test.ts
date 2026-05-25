import { describe, expect, it } from "vitest";
import {
  parseCodexModelCatalog,
  parseDeepseekModelList,
  parseKimiConfigModels,
  parseKimiRuntimeParameters,
} from "../runtime-models.js";

describe("runtime model discovery parsers", () => {
  it("parses visible Codex models and trims heavyweight catalog fields", () => {
    const models = parseCodexModelCatalog(
      JSON.stringify({
        models: [
          {
            slug: "gpt-5.5",
            display_name: "GPT-5.5",
            visibility: "list",
            supported_in_api: true,
            default_reasoning_level: "medium",
            supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }],
            base_instructions: "large prompt text should not be copied into metadata",
          },
          {
            slug: "internal-hidden",
            display_name: "Internal",
            visibility: "hide",
          },
        ],
      }),
    );

    expect(models).toEqual([
      {
        id: "gpt-5.5",
        displayName: "GPT-5.5",
        provider: "openai",
        source: "cli",
        metadata: {
          supportedInApi: true,
          defaultReasoningLevel: "medium",
          supportedReasoningLevels: ["low", "medium"],
        },
        parameters: [
          {
            id: "reasoning_effort",
            displayName: "Reasoning effort",
            type: "enum",
            flag: "-c model_reasoning_effort=<value>",
            values: ["low", "medium"],
            defaultValue: "medium",
            source: "cli",
          },
        ],
      },
    ]);
  });

  it("parses DeepSeek model list output", () => {
    expect(
      parseDeepseekModelList(
        [
          "deepseek-v4-pro (deepseek)",
          "gpt-4.1-mini (openai)",
          "deepseek-coder:1.3b (ollama)",
        ].join("\n"),
      ),
    ).toEqual([
      {
        id: "deepseek-v4-pro",
        displayName: "deepseek-v4-pro",
        provider: "deepseek",
        source: "cli",
      },
      {
        id: "gpt-4.1-mini",
        displayName: "gpt-4.1-mini",
        provider: "openai",
        source: "cli",
      },
      {
        id: "deepseek-coder:1.3b",
        displayName: "deepseek-coder:1.3b",
        provider: "ollama",
        source: "cli",
      },
    ]);
  });

  it("parses Kimi models from config.toml", () => {
    expect(
      parseKimiConfigModels(
        [
          'default_model = "kimi-code/kimi-for-coding"',
          "default_thinking = true",
          "",
          '[models."kimi-code/kimi-for-coding"]',
          'provider = "managed:kimi-code"',
          'model = "kimi-for-coding"',
          "max_context_size = 262144",
          'capabilities = ["thinking", "video_in", "image_in"]',
          'display_name = "Kimi-k2.6"',
        ].join("\n"),
      ),
    ).toEqual([
      {
        id: "kimi-code/kimi-for-coding",
        source: "config",
        isDefault: true,
        provider: "managed:kimi-code",
        displayName: "Kimi-k2.6",
        contextLength: 262144,
        capabilities: ["thinking", "video_in", "image_in"],
        metadata: { model: "kimi-for-coding" },
        parameters: [
          {
            id: "thinking",
            displayName: "Thinking",
            type: "boolean",
            flag: "--thinking/--no-thinking",
            defaultValue: true,
            source: "config",
          },
        ],
      },
    ]);
  });

  it("parses Kimi runtime parameters from config.toml", () => {
    expect(
      parseKimiRuntimeParameters(
        [
          'default_model = "kimi-code/kimi-for-coding"',
          "default_thinking = true",
          "default_yolo = false",
          "default_plan_mode = false",
          "show_thinking_stream = true",
          "max_steps_per_turn = 1000",
          "max_retries_per_step = 3",
          "max_ralph_iterations = 0",
          "reserved_context_size = 50000",
        ].join("\n"),
      ),
    ).toEqual([
      {
        id: "model",
        displayName: "Default model",
        type: "string",
        flag: "-m, --model",
        defaultValue: "kimi-code/kimi-for-coding",
        source: "config",
      },
      {
        id: "thinking",
        displayName: "Thinking",
        type: "boolean",
        flag: "--thinking/--no-thinking",
        defaultValue: true,
        source: "config",
      },
      {
        id: "show_thinking_stream",
        displayName: "Show thinking stream",
        type: "boolean",
        defaultValue: true,
        source: "config",
      },
      {
        id: "yolo",
        displayName: "Auto approve",
        type: "boolean",
        flag: "--yolo, --yes, -y",
        defaultValue: false,
        source: "config",
      },
      {
        id: "plan_mode",
        displayName: "Plan mode",
        type: "boolean",
        flag: "--plan",
        defaultValue: false,
        source: "config",
      },
      {
        id: "max_steps_per_turn",
        displayName: "Max steps per turn",
        type: "integer",
        flag: "--max-steps-per-turn",
        defaultValue: 1000,
        minimum: 1,
        source: "config",
      },
      {
        id: "max_retries_per_step",
        displayName: "Max retries per step",
        type: "integer",
        flag: "--max-retries-per-step",
        defaultValue: 3,
        minimum: 1,
        source: "config",
      },
      {
        id: "max_ralph_iterations",
        displayName: "Max Ralph iterations",
        type: "integer",
        flag: "--max-ralph-iterations",
        defaultValue: 0,
        minimum: -1,
        source: "config",
      },
      {
        id: "reserved_context_size",
        displayName: "Reserved context size",
        type: "integer",
        defaultValue: 50000,
        minimum: 0,
        source: "config",
      },
    ]);
  });
});
