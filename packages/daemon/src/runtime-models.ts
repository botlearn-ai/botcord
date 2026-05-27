import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { RuntimeModelProbe, RuntimeParameterProbe } from "@botcord/protocol-core";
import type { RuntimeProbeEntry } from "./adapters/runtimes.js";

const MODEL_LIST_TIMEOUT_MS = 5000;
const MODEL_LIST_MAX_BUFFER = 16 * 1024 * 1024;
const RUNTIME_CATALOG_CACHE_VERSION = 2;
const RUNTIME_CATALOG_CACHE_FRESH_MS = 10 * 60 * 1000;
const DEFAULT_RUNTIME_CATALOG_CACHE_DIR = path.join(
  homedir(),
  ".botcord",
  "daemon",
  "runtime-catalog-cache",
);

const CLAUDE_ALIAS_MODELS: RuntimeModelProbe[] = [
  { id: "default", displayName: "Default", provider: "anthropic", source: "builtin" },
  { id: "best", displayName: "Best", provider: "anthropic", source: "builtin" },
  { id: "sonnet", displayName: "Sonnet", provider: "anthropic", source: "builtin" },
  { id: "opus", displayName: "Opus", provider: "anthropic", source: "builtin" },
  { id: "haiku", displayName: "Haiku", provider: "anthropic", source: "builtin" },
  { id: "sonnet[1m]", displayName: "Sonnet 1M", provider: "anthropic", source: "builtin" },
  { id: "opus[1m]", displayName: "Opus 1M", provider: "anthropic", source: "builtin" },
  { id: "opusplan", displayName: "Opus Plan", provider: "anthropic", source: "builtin" },
];

const CLAUDE_EFFORT_VALUES = ["low", "medium", "high", "xhigh", "max"];
const CLAUDE_PERMISSION_MODE_VALUES = [
  "acceptEdits",
  "auto",
  "bypassPermissions",
  "default",
  "dontAsk",
  "plan",
];
const CODEX_SANDBOX_MODES = ["read-only", "workspace-write", "danger-full-access"];
const CODEX_APPROVAL_POLICIES = ["untrusted", "on-failure", "on-request", "never"];
const DEEPSEEK_PROVIDER_VALUES = [
  "deepseek",
  "nvidia-nim",
  "openai",
  "openrouter",
  "novita",
  "fireworks",
  "sglang",
  "vllm",
  "ollama",
];

const CODEX_FALLBACK_MODELS: RuntimeModelProbe[] = [
  { id: "gpt-5.2", displayName: "GPT-5.2", provider: "openai", source: "builtin" },
  { id: "gpt-5.1", displayName: "GPT-5.1", provider: "openai", source: "builtin" },
  { id: "gpt-5", displayName: "GPT-5", provider: "openai", source: "builtin" },
  { id: "o4-mini", displayName: "o4-mini", provider: "openai", source: "builtin" },
];

const DEEPSEEK_FALLBACK_MODELS: RuntimeModelProbe[] = [
  { id: "deepseek-v4-flash", displayName: "deepseek-v4-flash", provider: "deepseek", source: "builtin" },
];

const KIMI_FALLBACK_MODELS: RuntimeModelProbe[] = [
  { id: "kimi-code/kimi-for-coding", displayName: "Kimi for Coding", provider: "managed:kimi-code", source: "builtin" },
  { id: "kimi-k2-5", displayName: "kimi-k2-5", provider: "kimi", source: "builtin" },
  { id: "kimi-k2-5-preview", displayName: "kimi-k2-5-preview", provider: "kimi", source: "builtin" },
  { id: "kimi-k2-0711", displayName: "kimi-k2-0711", provider: "kimi", source: "builtin" },
];

export interface RuntimeModelDiscovery {
  models?: RuntimeModelProbe[];
  parameters?: RuntimeParameterProbe[];
}

interface RuntimeCatalogStrategy {
  id: string;
  contextKey: string;
  discoverFresh(): RuntimeModelDiscovery;
  fallback?(): RuntimeModelDiscovery;
}

interface RuntimeCatalogCacheFile {
  version: number;
  runtimeId: string;
  contextKey: string;
  updatedAt: number;
  catalog?: RuntimeModelDiscovery;
}

const backgroundRefreshes = new Set<string>();

export function discoverRuntimeModelCatalog(entry: RuntimeProbeEntry): RuntimeModelDiscovery {
  if (!entry.result.available) return {};
  const strategy = runtimeCatalogStrategy(entry);
  if (!strategy) return {};
  return discoverRuntimeCatalogWithCache(strategy);
}

function runtimeCatalogStrategy(entry: RuntimeProbeEntry): RuntimeCatalogStrategy | null {
  switch (entry.id) {
    case "claude-code":
      return {
        id: entry.id,
        contextKey: runtimeCatalogContextKey(entry, {
          settings: fileStatKey(path.join(homedir(), ".claude", "settings.json")),
          env: pickEnv([
            "ANTHROPIC_DEFAULT_OPUS_MODEL",
            "ANTHROPIC_DEFAULT_SONNET_MODEL",
            "ANTHROPIC_DEFAULT_HAIKU_MODEL",
            "ANTHROPIC_CUSTOM_MODEL_OPTION",
          ]),
        }),
        discoverFresh: discoverClaudeCatalog,
        fallback: () => ({ models: CLAUDE_ALIAS_MODELS.slice(), parameters: discoverClaudeParameters() }),
      };
    case "codex":
      return {
        id: entry.id,
        contextKey: runtimeCatalogContextKey(entry, {
          codexHome: codexHomeDir(),
          config: fileStatKey(path.join(codexHomeDir(), "config.toml")),
          cliCache: fileStatKey(codexModelCachePath()),
          env: pickEnv(["OPENAI_BASE_URL", "CODEX_HOME"]),
        }),
        discoverFresh: () => discoverCodexCatalog(entry.result.path),
        fallback: () => ({ models: CODEX_FALLBACK_MODELS.slice(), parameters: discoverCodexParameters(null) }),
      };
    case "deepseek-tui":
      return {
        id: entry.id,
        contextKey: runtimeCatalogContextKey(entry, {
          config: fileStatKey(path.join(homedir(), ".deepseek", "config.toml")),
          env: pickEnv(["BOTCORD_DEEPSEEK_TUI_BIN", "BOTCORD_DEEPSEEK_TUI_URL"]),
        }),
        discoverFresh: () => discoverDeepseekCatalog(entry.result.path),
        fallback: () => ({
          models: DEEPSEEK_FALLBACK_MODELS.slice(),
          parameters: discoverDeepseekParameters(entry.result.path),
        }),
      };
    case "kimi-cli":
      return {
        id: entry.id,
        contextKey: runtimeCatalogContextKey(entry, {
          config: fileStatKey(path.join(homedir(), ".kimi", "config.toml")),
          env: pickEnv(["BOTCORD_KIMI_CLI_BIN"]),
        }),
        discoverFresh: discoverKimiCatalog,
        fallback: () => ({
          models: KIMI_FALLBACK_MODELS.slice(),
          parameters: [
            {
              id: "thinking",
              displayName: "Thinking",
              type: "boolean",
              flag: "--thinking/--no-thinking",
              source: "builtin",
            },
          ],
        }),
      };
    default:
      return null;
  }
}

function discoverRuntimeCatalogWithCache(strategy: RuntimeCatalogStrategy): RuntimeModelDiscovery {
  const cached = readRuntimeCatalogCache(strategy.id, strategy.contextKey);
  if (cached && Date.now() - cached.updatedAt < RUNTIME_CATALOG_CACHE_FRESH_MS) {
    scheduleRuntimeCatalogRefresh(strategy);
    return cached.catalog;
  }

  try {
    const fresh = completeCatalogWithFallback(strategy.discoverFresh(), strategy);
    if (hasCatalogData(fresh)) {
      writeRuntimeCatalogCache(strategy.id, strategy.contextKey, fresh);
      return fresh;
    }
  } catch {
    // Fall through to stale cache or built-in fallback.
  }

  if (cached) return cached.catalog;

  try {
    const fallback = strategy.fallback?.() ?? {};
    return hasCatalogData(fallback) ? fallback : {};
  } catch {
    return {};
  }
}

export function discoverRuntimeModels(entry: RuntimeProbeEntry): RuntimeModelProbe[] | undefined {
  return discoverRuntimeModelCatalog(entry).models;
}

export function discoverRuntimeParameters(entry: RuntimeProbeEntry): RuntimeParameterProbe[] | undefined {
  return discoverRuntimeModelCatalog(entry).parameters;
}

function completeCatalogWithFallback(
  catalog: RuntimeModelDiscovery,
  strategy: RuntimeCatalogStrategy,
): RuntimeModelDiscovery {
  if (catalog.models?.length) return catalog;
  const fallback = strategy.fallback?.();
  if (!fallback?.models?.length) return catalog;
  return {
    ...catalog,
    models: fallback.models,
  };
}

function discoverClaudeCatalog(): RuntimeModelDiscovery {
  return {
    models: discoverClaudeModels(),
    parameters: discoverClaudeParameters(),
  };
}

export function discoverClaudeModels(): RuntimeModelProbe[] {
  const models = new Map<string, RuntimeModelProbe>();
  const add = (model: RuntimeModelProbe): void => {
    if (!model.id) return;
    const existing = models.get(model.id);
    models.set(model.id, { ...existing, ...model });
  };

  for (const model of CLAUDE_ALIAS_MODELS) add(model);

  const settings = readJsonObject(path.join(homedir(), ".claude", "settings.json"));
  const defaultModel = stringField(settings, "model");
  if (defaultModel) {
    add({
      id: defaultModel,
      displayName: defaultModel,
      provider: "anthropic",
      source: "config",
      isDefault: true,
    });
  }

  for (const item of arrayField(settings, "availableModels")) {
    if (typeof item === "string" && item) {
      add({ id: item, displayName: item, provider: "anthropic", source: "config" });
    }
  }

  for (const envName of [
    "ANTHROPIC_DEFAULT_OPUS_MODEL",
    "ANTHROPIC_DEFAULT_SONNET_MODEL",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    "ANTHROPIC_CUSTOM_MODEL_OPTION",
  ]) {
    const value = process.env[envName];
    if (value) {
      add({
        id: value,
        displayName: value,
        provider: "anthropic",
        source: "env",
        metadata: { env: envName },
      });
    }
  }

  return Array.from(models.values());
}

function discoverClaudeParameters(): RuntimeParameterProbe[] {
  const settings = readJsonObject(path.join(homedir(), ".claude", "settings.json"));
  const effort = stringField(settings, "effort");
  const permissionMode =
    stringField(settings, "permissionMode") ?? stringField(settings, "permission-mode");
  const out: RuntimeParameterProbe[] = [
    {
      id: "effort",
      displayName: "Effort",
      type: "enum",
      flag: "--effort",
      values: CLAUDE_EFFORT_VALUES,
      source: "cli",
    },
    {
      id: "permission_mode",
      displayName: "Permission mode",
      type: "enum",
      flag: "--permission-mode",
      values: CLAUDE_PERMISSION_MODE_VALUES,
      source: "cli",
    },
  ];
  if (effort) out[0] = { ...out[0]!, defaultValue: effort, source: "config" };
  if (permissionMode) out[1] = { ...out[1]!, defaultValue: permissionMode, source: "config" };
  return out;
}

function discoverCodexCatalog(command: string | undefined): RuntimeModelDiscovery {
  const raw = runCommand(codexCommand(command), ["debug", "models"]);
  const fallbackRaw = raw ?? readCodexModelCacheRaw();
  return {
    models: fallbackRaw ? parseCodexModelCatalog(fallbackRaw) : undefined,
    parameters: discoverCodexParameters(fallbackRaw),
  };
}

export function discoverCodexModels(command: string | undefined): RuntimeModelProbe[] | undefined {
  return discoverCodexCatalog(command).models;
}

export function parseCodexModelCatalog(raw: string): RuntimeModelProbe[] | undefined {
  const parsed = JSON.parse(raw) as { models?: unknown[] };
  if (!Array.isArray(parsed.models)) return undefined;
  const out: RuntimeModelProbe[] = [];
  for (const item of parsed.models) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    const id = stringField(obj, "slug");
    if (!id) continue;
    if (stringField(obj, "visibility") === "hide") continue;

    const model: RuntimeModelProbe = {
      id,
      provider: "openai",
      source: "cli",
    };
    const displayName = stringField(obj, "display_name") ?? stringField(obj, "description");
    if (displayName) model.displayName = displayName;

    const metadata: Record<string, unknown> = {};
    const supportedInApi = obj.supported_in_api;
    if (typeof supportedInApi === "boolean") metadata.supportedInApi = supportedInApi;
    const defaultReasoningLevel = stringField(obj, "default_reasoning_level");
    if (defaultReasoningLevel) metadata.defaultReasoningLevel = defaultReasoningLevel;
    const supportedReasoningLevels = arrayField(obj, "supported_reasoning_levels")
      .map((level) =>
        level && typeof level === "object"
          ? stringField(level as Record<string, unknown>, "effort")
          : undefined,
      )
      .filter((level): level is string => !!level);
    if (supportedReasoningLevels.length) metadata.supportedReasoningLevels = supportedReasoningLevels;
    if (Object.keys(metadata).length) model.metadata = metadata;
    if (supportedReasoningLevels.length) {
      model.parameters = [
        {
          id: "reasoning_effort",
          displayName: "Reasoning effort",
          type: "enum",
          flag: "-c model_reasoning_effort=<value>",
          values: supportedReasoningLevels,
          ...(defaultReasoningLevel ? { defaultValue: defaultReasoningLevel } : {}),
          source: "cli",
        },
      ];
    }

    out.push(model);
  }
  return out.length ? out : undefined;
}

function discoverCodexParameters(rawCatalog: string | null): RuntimeParameterProbe[] {
  const config = readConfigScalars(path.join(homedir(), ".codex", "config.toml"));
  const reasoningValues = new Set<string>();
  if (rawCatalog) {
    try {
      const parsed = JSON.parse(rawCatalog) as { models?: unknown[] };
      if (Array.isArray(parsed.models)) {
        for (const item of parsed.models) {
          if (!item || typeof item !== "object") continue;
          for (const level of arrayField(item as Record<string, unknown>, "supported_reasoning_levels")) {
            if (!level || typeof level !== "object") continue;
            const effort = stringField(level as Record<string, unknown>, "effort");
            if (effort) reasoningValues.add(effort);
          }
        }
      }
    } catch {
      // ignore malformed catalog; runtime-level defaults still come from config.
    }
  }
  return [
    compactParameter({
      id: "model",
      displayName: "Default model",
      type: "string",
      flag: "-m, --model",
      defaultValue: config.model,
      source: config.model ? "config" : "cli",
    }),
    compactParameter({
      id: "reasoning_effort",
      displayName: "Reasoning effort",
      type: reasoningValues.size > 0 ? "enum" : "string",
      flag: "-c model_reasoning_effort=<value>",
      values: reasoningValues.size > 0 ? Array.from(reasoningValues) : undefined,
      defaultValue: config.model_reasoning_effort,
      source: config.model_reasoning_effort ? "config" : "cli",
      metadata: { scope: "per-model-values-may-differ" },
    }),
    compactParameter({
      id: "approval_policy",
      displayName: "Approval policy",
      type: "enum",
      flag: "-a, --ask-for-approval",
      values: CODEX_APPROVAL_POLICIES,
      defaultValue: config.approval_policy,
      source: config.approval_policy ? "config" : "cli",
    }),
    compactParameter({
      id: "sandbox_mode",
      displayName: "Sandbox mode",
      type: "enum",
      flag: "-s, --sandbox",
      values: CODEX_SANDBOX_MODES,
      defaultValue: config.sandbox_mode,
      source: config.sandbox_mode ? "config" : "cli",
    }),
    compactParameter({
      id: "web_search",
      displayName: "Web search",
      type: "boolean",
      flag: "--search",
      defaultValue: parseTomlBool(config.web_search),
      source: config.web_search ? "config" : "cli",
    }),
  ];
}

function discoverDeepseekCatalog(command: string | undefined): RuntimeModelDiscovery {
  return {
    models: discoverDeepseekModels(command),
    parameters: discoverDeepseekParameters(command),
  };
}

export function discoverDeepseekModels(command: string | undefined): RuntimeModelProbe[] | undefined {
  const raw = runCommand([command ?? "deepseek"], ["model", "list"]);
  if (!raw) return undefined;
  return parseDeepseekModelList(raw);
}

export function parseDeepseekModelList(raw: string): RuntimeModelProbe[] | undefined {
  const out: RuntimeModelProbe[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^(.+?)\s+\(([^()]+)\)$/);
    const id = match ? match[1]!.trim() : trimmed;
    const provider = match ? match[2]!.trim() : "deepseek";
    if (!id) continue;
    out.push({ id, displayName: id, provider, source: "cli" });
  }
  return out.length ? out : undefined;
}

function discoverDeepseekParameters(command?: string): RuntimeParameterProbe[] {
  const config = readConfigScalars(path.join(homedir(), ".deepseek", "config.toml"));
  const reasoningEffortValues = discoverDeepseekReasoningEffortValues(command);
  return [
    compactParameter({
      id: "model",
      displayName: "Default model",
      type: "string",
      flag: "--model",
      defaultValue: config.default_text_model,
      source: config.default_text_model ? "config" : "cli",
    }),
    compactParameter({
      id: "provider",
      displayName: "Provider",
      type: "enum",
      flag: "--provider",
      values: DEEPSEEK_PROVIDER_VALUES,
      defaultValue: config.provider,
      source: config.provider ? "config" : "cli",
    }),
    compactParameter({
      id: "reasoning_effort",
      displayName: "Reasoning effort",
      type: reasoningEffortValues.length > 0 ? "enum" : "string",
      flag: "--reasoning-effort",
      values: reasoningEffortValues.length > 0 ? reasoningEffortValues : undefined,
      defaultValue: config.reasoning_effort,
      source: config.reasoning_effort ? "config" : "cli",
    }),
    compactParameter({
      id: "approval_policy",
      displayName: "Approval policy",
      type: "string",
      flag: "--approval-policy",
      defaultValue: config.approval_policy,
      source: config.approval_policy ? "config" : "cli",
    }),
    compactParameter({
      id: "sandbox_mode",
      displayName: "Sandbox mode",
      type: "string",
      flag: "--sandbox-mode",
      defaultValue: config.sandbox_mode,
      source: config.sandbox_mode ? "config" : "cli",
    }),
  ];
}

function discoverDeepseekReasoningEffortValues(command: string | undefined): string[] {
  const candidates = deepseekRuntimeTemplateCandidates(command);
  const values = new Set<string>();
  for (const candidate of candidates) {
    try {
      const raw = readFileSync(candidate)
        .toString("latin1")
        .replace(/[^\x20-\x7E]+/g, "\n");
      const templateRe =
        /Thinking mode \(DeepSeek V4 reasoning effort\):[\s\S]{0,256}?#\s*((?:"[^"]+"\s*(?:\|\s*)?)+)/g;
      for (const match of raw.matchAll(templateRe)) {
        const line = match[1] ?? "";
        for (const valueMatch of line.matchAll(/"([^"]+)"/g)) {
          const value = valueMatch[1]?.trim();
          if (value && /^[A-Za-z0-9_.-]+$/.test(value)) values.add(value);
        }
      }
    } catch {
      // Try the next candidate; runtime discovery should stay best-effort.
    }
  }
  return Array.from(values);
}

function deepseekRuntimeTemplateCandidates(command: string | undefined): string[] {
  if (!command) return [];
  const candidates = new Set<string>();
  if (existsSync(command)) candidates.add(command);
  const dir = path.dirname(command);
  for (const candidate of [
    path.join(dir, "deepseek-tui"),
    path.join(dir, "downloads", "deepseek-tui"),
  ]) {
    if (existsSync(candidate)) candidates.add(candidate);
  }
  return Array.from(candidates);
}

function discoverKimiCatalog(): RuntimeModelDiscovery {
  const configPath = path.join(homedir(), ".kimi", "config.toml");
  if (!existsSync(configPath)) return {};
  const raw = readFileSync(configPath, "utf8");
  return {
    models: parseKimiConfigModels(raw),
    parameters: parseKimiRuntimeParameters(raw),
  };
}

export function discoverKimiModels(): RuntimeModelProbe[] | undefined {
  return discoverKimiCatalog().models;
}

export function parseKimiConfigModels(raw: string): RuntimeModelProbe[] | undefined {
  const defaultModel = matchScalar(raw, /^default_model\s*=\s*["']([^"']+)["']/m);
  const out: RuntimeModelProbe[] = [];
  const sectionRe = /^\[models\."([^"]+)"\]\s*$/gm;
  const matches = Array.from(raw.matchAll(sectionRe));
  for (let i = 0; i < matches.length; i += 1) {
    const match = matches[i]!;
    const id = match[1]!;
    const start = (match.index ?? 0) + match[0].length;
    const end = i + 1 < matches.length ? matches[i + 1]!.index ?? raw.length : raw.length;
    const body = raw.slice(start, end);
    const model: RuntimeModelProbe = {
      id,
      source: "config",
      isDefault: id === defaultModel,
    };
    const provider = matchScalar(body, /^\s*provider\s*=\s*["']([^"']+)["']/m);
    if (provider) model.provider = provider;
    const displayName = matchScalar(body, /^\s*display_name\s*=\s*["']([^"']+)["']/m);
    if (displayName) model.displayName = displayName;
    const contextLength = matchScalar(body, /^\s*max_context_size\s*=\s*(\d+)/m);
    if (contextLength) model.contextLength = Number(contextLength);
    const capabilities = matchArray(body, /^\s*capabilities\s*=\s*\[([^\]]*)\]/m);
    if (capabilities.length) model.capabilities = capabilities;
    if (capabilities.includes("thinking")) {
      const defaultThinking = parseTomlBool(matchScalar(raw, /^default_thinking\s*=\s*(true|false)/m));
      model.parameters = [
        compactParameter({
          id: "thinking",
          displayName: "Thinking",
          type: "boolean",
          flag: "--thinking/--no-thinking",
          defaultValue: defaultThinking,
          source: defaultThinking === undefined ? "cli" : "config",
        }),
      ];
    }
    const runtimeModel = matchScalar(body, /^\s*model\s*=\s*["']([^"']+)["']/m);
    if (runtimeModel) model.metadata = { model: runtimeModel };
    out.push(model);
  }
  return out.length ? out : undefined;
}

export function parseKimiRuntimeParameters(raw: string): RuntimeParameterProbe[] {
  return [
    compactParameter({
      id: "model",
      displayName: "Default model",
      type: "string",
      flag: "-m, --model",
      defaultValue: matchScalar(raw, /^default_model\s*=\s*["']([^"']+)["']/m),
      source: "config",
    }),
    compactParameter({
      id: "thinking",
      displayName: "Thinking",
      type: "boolean",
      flag: "--thinking/--no-thinking",
      defaultValue: parseTomlBool(matchScalar(raw, /^default_thinking\s*=\s*(true|false)/m)),
      source: "config",
    }),
    compactParameter({
      id: "show_thinking_stream",
      displayName: "Show thinking stream",
      type: "boolean",
      defaultValue: parseTomlBool(matchScalar(raw, /^show_thinking_stream\s*=\s*(true|false)/m)),
      source: "config",
    }),
    compactParameter({
      id: "yolo",
      displayName: "Auto approve",
      type: "boolean",
      flag: "--yolo, --yes, -y",
      defaultValue: parseTomlBool(matchScalar(raw, /^default_yolo\s*=\s*(true|false)/m)),
      source: "config",
    }),
    compactParameter({
      id: "plan_mode",
      displayName: "Plan mode",
      type: "boolean",
      flag: "--plan",
      defaultValue: parseTomlBool(matchScalar(raw, /^default_plan_mode\s*=\s*(true|false)/m)),
      source: "config",
    }),
    compactParameter({
      id: "max_steps_per_turn",
      displayName: "Max steps per turn",
      type: "integer",
      flag: "--max-steps-per-turn",
      defaultValue: parseTomlInt(matchScalar(raw, /^max_steps_per_turn\s*=\s*(\d+)/m)),
      minimum: 1,
      source: "config",
    }),
    compactParameter({
      id: "max_retries_per_step",
      displayName: "Max retries per step",
      type: "integer",
      flag: "--max-retries-per-step",
      defaultValue: parseTomlInt(matchScalar(raw, /^max_retries_per_step\s*=\s*(\d+)/m)),
      minimum: 1,
      source: "config",
    }),
    compactParameter({
      id: "max_ralph_iterations",
      displayName: "Max Ralph iterations",
      type: "integer",
      flag: "--max-ralph-iterations",
      defaultValue: parseTomlInt(matchScalar(raw, /^max_ralph_iterations\s*=\s*(-?\d+)/m)),
      minimum: -1,
      source: "config",
    }),
    compactParameter({
      id: "reserved_context_size",
      displayName: "Reserved context size",
      type: "integer",
      defaultValue: parseTomlInt(matchScalar(raw, /^reserved_context_size\s*=\s*(\d+)/m)),
      minimum: 0,
      source: "config",
    }),
  ];
}

function runtimeCatalogContextKey(
  entry: RuntimeProbeEntry,
  extra: Record<string, unknown>,
): string {
  return JSON.stringify({
    runtime: entry.id,
    path: entry.result.path ?? null,
    version: entry.result.version ?? null,
    home: homedir(),
    ...extra,
  });
}

function runtimeCatalogCacheDir(): string | null {
  const explicit = process.env.BOTCORD_RUNTIME_CATALOG_CACHE_DIR;
  if (explicit && explicit.length > 0) return expandLeadingTilde(explicit);
  // Keep unit tests from writing to a developer's real ~/.botcord unless a
  // test opts into a temp cache directory explicitly.
  if (process.env.NODE_ENV === "test") return null;
  if (process.env.BOTCORD_RUNTIME_CATALOG_CACHE === "0") return null;
  return DEFAULT_RUNTIME_CATALOG_CACHE_DIR;
}

function runtimeCatalogCachePath(runtimeId: string): string | null {
  const dir = runtimeCatalogCacheDir();
  if (!dir) return null;
  const safe = runtimeId.replace(/[^A-Za-z0-9_.-]+/g, "_");
  return path.join(dir, `${safe}.json`);
}

function readRuntimeCatalogCache(
  runtimeId: string,
  contextKey: string,
): { updatedAt: number; catalog: RuntimeModelDiscovery } | null {
  const file = runtimeCatalogCachePath(runtimeId);
  if (!file) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as RuntimeCatalogCacheFile;
    if (!parsed || typeof parsed !== "object") return null;
    if (parsed.version !== RUNTIME_CATALOG_CACHE_VERSION) return null;
    if (parsed.runtimeId !== runtimeId || parsed.contextKey !== contextKey) return null;
    if (typeof parsed.updatedAt !== "number" || parsed.updatedAt <= 0) return null;
    const catalog = normalizeCachedCatalog(parsed.catalog);
    if (!catalog) return null;
    return { updatedAt: parsed.updatedAt, catalog };
  } catch {
    return null;
  }
}

function writeRuntimeCatalogCache(
  runtimeId: string,
  contextKey: string,
  catalog: RuntimeModelDiscovery,
): void {
  if (!hasCatalogData(catalog)) return;
  const file = runtimeCatalogCachePath(runtimeId);
  if (!file) return;
  try {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    const payload: RuntimeCatalogCacheFile = {
      version: RUNTIME_CATALOG_CACHE_VERSION,
      runtimeId,
      contextKey,
      updatedAt: Date.now(),
      catalog,
    };
    writeFileSync(tmp, JSON.stringify(payload, null, 2), { mode: 0o600 });
    renameSync(tmp, file);
  } catch {
    // Cache writes must never affect runtime discovery.
  }
}

function scheduleRuntimeCatalogRefresh(strategy: RuntimeCatalogStrategy): void {
  if (process.env.NODE_ENV === "test") return;
  if (process.env.BOTCORD_RUNTIME_CATALOG_BACKGROUND_REFRESH === "0") return;
  const cacheKey = `${strategy.id}:${strategy.contextKey}`;
  if (backgroundRefreshes.has(cacheKey)) return;
  backgroundRefreshes.add(cacheKey);
  const timer = setTimeout(() => {
    try {
      const fresh = completeCatalogWithFallback(strategy.discoverFresh(), strategy);
      if (hasCatalogData(fresh)) {
        writeRuntimeCatalogCache(strategy.id, strategy.contextKey, fresh);
      }
    } catch {
      // Keep serving the previous cache entry.
    } finally {
      backgroundRefreshes.delete(cacheKey);
    }
  }, 0);
  timer.unref?.();
}

function normalizeCachedCatalog(raw: unknown): RuntimeModelDiscovery | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const models = normalizeCachedModels(obj.models);
  const parameters = normalizeCachedParameters(obj.parameters);
  const out: RuntimeModelDiscovery = {};
  if (models?.length) out.models = models;
  if (parameters?.length) out.parameters = parameters;
  return hasCatalogData(out) ? out : null;
}

function normalizeCachedModels(raw: unknown): RuntimeModelProbe[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const models = raw
    .map((item): RuntimeModelProbe | null => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return null;
      const obj = item as Record<string, unknown>;
      const id = stringField(obj, "id");
      if (!id) return null;
      const model: RuntimeModelProbe = { id };
      const displayName = stringField(obj, "displayName");
      if (displayName) model.displayName = displayName;
      const provider = stringField(obj, "provider");
      if (provider) model.provider = provider;
      const source = stringField(obj, "source");
      if (isRuntimeCatalogSource(source)) model.source = source;
      if (obj.isDefault === true) model.isDefault = true;
      const capabilities = arrayField(obj, "capabilities").filter(
        (cap): cap is string => typeof cap === "string" && cap.length > 0,
      );
      if (capabilities.length) model.capabilities = capabilities;
      if (typeof obj.contextLength === "number") model.contextLength = obj.contextLength;
      if (obj.metadata && typeof obj.metadata === "object" && !Array.isArray(obj.metadata)) {
        model.metadata = obj.metadata as Record<string, unknown>;
      }
      const parameters = normalizeCachedParameters(obj.parameters);
      if (parameters?.length) model.parameters = parameters;
      return model;
    })
    .filter((model): model is RuntimeModelProbe => !!model);
  return models.length ? models : undefined;
}

function normalizeCachedParameters(raw: unknown): RuntimeParameterProbe[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const parameters = raw
    .map((item): RuntimeParameterProbe | null => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return null;
      const obj = item as Record<string, unknown>;
      const id = stringField(obj, "id");
      const type = stringField(obj, "type");
      if (!id || !isRuntimeParameterType(type)) return null;
      const param: RuntimeParameterProbe = { id, type };
      const displayName = stringField(obj, "displayName");
      if (displayName) param.displayName = displayName;
      const flag = stringField(obj, "flag");
      if (flag) param.flag = flag;
      const values = arrayField(obj, "values").filter(isRuntimeParameterValue);
      if (values.length) param.values = values;
      if (isRuntimeParameterValue(obj.defaultValue)) param.defaultValue = obj.defaultValue;
      if (typeof obj.minimum === "number") param.minimum = obj.minimum;
      if (typeof obj.maximum === "number") param.maximum = obj.maximum;
      const source = stringField(obj, "source");
      if (isRuntimeCatalogSource(source)) param.source = source;
      if (obj.metadata && typeof obj.metadata === "object" && !Array.isArray(obj.metadata)) {
        param.metadata = obj.metadata as Record<string, unknown>;
      }
      return param;
    })
    .filter((param): param is RuntimeParameterProbe => !!param);
  return parameters.length ? parameters : undefined;
}

function isRuntimeCatalogSource(value: string | undefined): value is RuntimeModelProbe["source"] {
  return (
    value === "builtin" ||
    value === "config" ||
    value === "cli" ||
    value === "api" ||
    value === "gateway" ||
    value === "env"
  );
}

function isRuntimeParameterType(value: string | undefined): value is RuntimeParameterProbe["type"] {
  return value === "enum" || value === "boolean" || value === "integer" || value === "string";
}

function isRuntimeParameterValue(value: unknown): value is string | number | boolean {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function hasCatalogData(catalog: RuntimeModelDiscovery): boolean {
  return !!(catalog.models?.length || catalog.parameters?.length);
}

function fileStatKey(file: string): string | null {
  try {
    const st = statSync(file);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return null;
  }
}

function pickEnv(names: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of names) {
    const value = process.env[name];
    if (value) out[name] = value;
  }
  return out;
}

function codexHomeDir(): string {
  return process.env.CODEX_HOME ? expandLeadingTilde(process.env.CODEX_HOME) : path.join(homedir(), ".codex");
}

function codexModelCachePath(): string {
  return path.join(codexHomeDir(), "models_cache.json");
}

function readCodexModelCacheRaw(): string | null {
  try {
    return readFileSync(codexModelCachePath(), "utf8");
  } catch {
    return null;
  }
}

function expandLeadingTilde(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return path.join(homedir(), value.slice(2));
  return value;
}

function codexCommand(command: string | undefined): string[] {
  if (command?.endsWith(".js")) return [process.execPath, command];
  return [command ?? "codex"];
}

function runCommand(command: string[], args: string[]): string | null {
  try {
    return execFileSync(command[0]!, [...command.slice(1), ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: MODEL_LIST_TIMEOUT_MS,
      maxBuffer: MODEL_LIST_MAX_BUFFER,
      env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
    });
  } catch {
    return null;
  }
}

function readJsonObject(file: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function readConfigScalars(file: string): Record<string, string | undefined> {
  try {
    const raw = readFileSync(file, "utf8");
    const out: Record<string, string | undefined> = {};
    for (const match of raw.matchAll(/^([A-Za-z0-9_.-]+)\s*=\s*(.+?)\s*$/gm)) {
      const key = match[1];
      const rawValue = match[2]?.trim();
      if (!key || !rawValue) continue;
      out[key] = rawValue.replace(/^["']|["']$/g, "");
    }
    return out;
  } catch {
    return {};
  }
}

function compactParameter(param: RuntimeParameterProbe): RuntimeParameterProbe {
  const out: RuntimeParameterProbe = {
    id: param.id,
    type: param.type,
  };
  if (param.displayName) out.displayName = param.displayName;
  if (param.flag) out.flag = param.flag;
  if (param.values?.length) out.values = param.values;
  if (param.defaultValue !== undefined) out.defaultValue = param.defaultValue;
  if (param.minimum !== undefined) out.minimum = param.minimum;
  if (param.maximum !== undefined) out.maximum = param.maximum;
  if (param.source) out.source = param.source;
  if (param.metadata && Object.keys(param.metadata).length > 0) out.metadata = param.metadata;
  return out;
}

function parseTomlBool(value: string | undefined): boolean | undefined {
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

function parseTomlInt(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  return Number.isInteger(n) ? n : undefined;
}

function stringField(obj: Record<string, unknown> | null, key: string): string | undefined {
  const value = obj?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function arrayField(obj: Record<string, unknown> | null, key: string): unknown[] {
  const value = obj?.[key];
  return Array.isArray(value) ? value : [];
}

function matchScalar(raw: string, re: RegExp): string | undefined {
  const match = raw.match(re);
  return match?.[1]?.trim() || undefined;
}

function matchArray(raw: string, re: RegExp): string[] {
  const match = raw.match(re);
  if (!match?.[1]) return [];
  return match[1]
    .split(",")
    .map((part) => part.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
}
