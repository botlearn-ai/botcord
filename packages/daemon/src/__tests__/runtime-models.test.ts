import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  discoverRuntimeModelCatalog,
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

  it("parses Codex CLI cache descriptions", () => {
    expect(
      parseCodexModelCatalog(
        JSON.stringify({
          models: [
            {
              slug: "gpt-cache",
              description: "Cached GPT",
              visibility: "list",
              supported_in_api: true,
            },
          ],
        }),
      ),
    ).toEqual([
      {
        id: "gpt-cache",
        displayName: "Cached GPT",
        provider: "openai",
        source: "cli",
        metadata: { supportedInApi: true },
      },
    ]);
  });

  it("uses the Codex CLI model cache when live discovery is unavailable", () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "daemon-codex-cache-"));
    const prevHome = process.env.HOME;
    const prevCodexHome = process.env.CODEX_HOME;
    try {
      const codexHome = path.join(tmp, "codex-home");
      mkdirSync(codexHome, { recursive: true });
      process.env.HOME = path.join(tmp, "home");
      process.env.CODEX_HOME = codexHome;
      writeFileSync(
        path.join(codexHome, "models_cache.json"),
        JSON.stringify({
          models: [
            {
              slug: "gpt-cache",
              description: "Cached GPT",
              visibility: "list",
            },
          ],
        }),
      );

      const catalog = discoverRuntimeModelCatalog({
        id: "codex",
        displayName: "Codex",
        binary: "codex",
        supportsRun: true,
        result: { available: true, path: path.join(tmp, "missing-codex") },
      });

      expect(catalog.models).toEqual([
        {
          id: "gpt-cache",
          displayName: "Cached GPT",
          provider: "openai",
          source: "cli",
        },
      ]);
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = prevCodexHome;
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("falls back to built-in Codex models and persists the runtime catalog cache", () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "daemon-runtime-catalog-"));
    const prevHome = process.env.HOME;
    const prevCodexHome = process.env.CODEX_HOME;
    const prevCacheDir = process.env.BOTCORD_RUNTIME_CATALOG_CACHE_DIR;
    try {
      const codexHome = path.join(tmp, "codex-home");
      const cacheDir = path.join(tmp, "catalog-cache");
      mkdirSync(codexHome, { recursive: true });
      process.env.HOME = path.join(tmp, "home");
      process.env.CODEX_HOME = codexHome;
      process.env.BOTCORD_RUNTIME_CATALOG_CACHE_DIR = cacheDir;

      const catalog = discoverRuntimeModelCatalog({
        id: "codex",
        displayName: "Codex",
        binary: "codex",
        supportsRun: true,
        result: { available: true, path: path.join(tmp, "missing-codex") },
      });

      expect(catalog.models?.map((m) => m.id)).toContain("gpt-5.2");
      expect(readdirSync(cacheDir)).toEqual(["codex.json"]);
      const payload = JSON.parse(readFileSync(path.join(cacheDir, "codex.json"), "utf8"));
      expect(payload.runtimeId).toBe("codex");
      expect(payload.catalog.models.map((m: { id: string }) => m.id)).toContain("gpt-5.2");
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = prevCodexHome;
      if (prevCacheDir === undefined) delete process.env.BOTCORD_RUNTIME_CATALOG_CACHE_DIR;
      else process.env.BOTCORD_RUNTIME_CATALOG_CACHE_DIR = prevCacheDir;
      rmSync(tmp, { recursive: true, force: true });
    }
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
