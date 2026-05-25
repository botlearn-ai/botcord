import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { RuntimeModelProbe, RuntimeParameterProbe } from "@botcord/protocol-core";
import type { RuntimeProbeEntry } from "./adapters/runtimes.js";

const MODEL_LIST_TIMEOUT_MS = 5000;
const MODEL_LIST_MAX_BUFFER = 16 * 1024 * 1024;

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

export interface RuntimeModelDiscovery {
  models?: RuntimeModelProbe[];
  parameters?: RuntimeParameterProbe[];
}

export function discoverRuntimeModelCatalog(entry: RuntimeProbeEntry): RuntimeModelDiscovery {
  if (!entry.result.available) return {};
  try {
    switch (entry.id) {
      case "claude-code":
        return discoverClaudeCatalog();
      case "codex":
        return discoverCodexCatalog(entry.result.path);
      case "deepseek-tui":
        return discoverDeepseekCatalog(entry.result.path);
      case "kimi-cli":
        return discoverKimiCatalog();
      default:
        return {};
    }
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
  return {
    models: raw ? parseCodexModelCatalog(raw) : undefined,
    parameters: discoverCodexParameters(raw),
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
    const displayName = stringField(obj, "display_name");
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
    parameters: discoverDeepseekParameters(),
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

function discoverDeepseekParameters(): RuntimeParameterProbe[] {
  const config = readConfigScalars(path.join(homedir(), ".deepseek", "config.toml"));
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
      type: "string",
      flag: "reasoning_effort",
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
