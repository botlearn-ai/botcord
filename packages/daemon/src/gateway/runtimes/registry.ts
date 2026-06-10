import { ClaudeCodeAdapter, probeClaude } from "./claude-code.js";
import { CodexAdapter, probeCodex } from "./codex.js";
import { DeepseekTuiAdapter, probeDeepseekTui } from "./deepseek-tui.js";
import { GeminiAdapter, probeGemini } from "./gemini.js";
import { HermesAgentAdapter, probeHermesAgent } from "./hermes-agent.js";
import { KimiAdapter, probeKimi } from "./kimi.js";
import { OpenclawAcpAdapter, probeOpenclaw } from "./openclaw-acp.js";
import type { RuntimeAdapter, RuntimeProbeResult } from "../types.js";

/**
 * How a runtime CLI can be brought up to date without user interaction.
 * - `self`: the binary ships its own updater — run `<binary> <args>`.
 * - `npm`: no self-updater; when the installed binary is npm-managed,
 *   run `npm install -g <pkg>@latest`. Non-npm installs (brew, native)
 *   are skipped rather than guessed at.
 * Runtimes without a spec (pip-installed, unknown channel) are never
 * auto-updated.
 */
export type RuntimeUpdateSpec =
  | { kind: "self"; args: string[] }
  | { kind: "npm"; pkg: string };

/**
 * Metadata + factory for a single runtime adapter, used by the registry.
 * Add a new runtime by exporting one of these from the adapter file and
 * registering it in `REGISTRY` below.
 */
export interface RuntimeModule {
  id: string;
  displayName: string;
  /** Canonical PATH binary name — shown in `doctor` output. */
  binary: string;
  /**
   * Env var that overrides the resolved CLI path for this adapter.
   * Defaults to `BOTCORD_<ID>_BIN` with dashes → underscores, uppercased.
   */
  envVar?: string;
  /** Module-level probe so callers don't have to instantiate the adapter. */
  probe(): RuntimeProbeResult;
  create(): RuntimeAdapter;
  /**
   * Whether `create().run()` is implemented. Defaults to true. Stubs
   * (e.g. gemini until we wire its driver) should set `false` so the
   * config loader rejects routing turns to this adapter.
   */
  supportsRun?: boolean;
  /**
   * Short, single-line install hint shown by `doctor` when the runtime
   * probes as unavailable. Helps users recover without reading source.
   */
  installHint?: string;
  /** Auto-update channel for this runtime; absent → never auto-updated. */
  update?: RuntimeUpdateSpec;
}

/** Built-in runtime module entry for Claude Code. */
export const claudeCodeModule: RuntimeModule = {
  id: "claude-code",
  displayName: "Claude Code",
  binary: "claude",
  envVar: "BOTCORD_CLAUDE_BIN",
  probe: () => probeClaude(),
  create: () => new ClaudeCodeAdapter(),
  update: { kind: "self", args: ["update"] },
};

/** Built-in runtime module entry for Codex. */
export const codexModule: RuntimeModule = {
  id: "codex",
  displayName: "Codex CLI",
  binary: "codex",
  probe: () => probeCodex(),
  create: () => new CodexAdapter(),
  update: { kind: "npm", pkg: "@openai/codex" },
};

/** Built-in runtime module entry for DeepSeek TUI. */
export const deepseekTuiModule: RuntimeModule = {
  id: "deepseek-tui",
  displayName: "DeepSeek TUI",
  binary: "deepseek",
  envVar: "BOTCORD_DEEPSEEK_TUI_BIN",
  probe: () => probeDeepseekTui(),
  create: () => new DeepseekTuiAdapter(),
  installHint:
    "Install DeepSeek TUI and ensure the `deepseek` dispatcher is on PATH, or set BOTCORD_DEEPSEEK_TUI_BIN.",
};

/** Built-in runtime module entry for Kimi CLI. */
export const kimiModule: RuntimeModule = {
  id: "kimi-cli",
  displayName: "Kimi CLI",
  binary: "kimi",
  envVar: "BOTCORD_KIMI_CLI_BIN",
  probe: () => probeKimi(),
  create: () => new KimiAdapter(),
};

/** Built-in runtime module entry for Hermes Agent (ACP stdio). */
export const hermesAgentModule: RuntimeModule = {
  id: "hermes-agent",
  displayName: "Hermes Agent",
  binary: "hermes-acp",
  envVar: "BOTCORD_HERMES_AGENT_BIN",
  probe: () => probeHermesAgent(),
  create: () => new HermesAgentAdapter(),
  installHint:
    'Install: pip install "hermes-agent[acp]"  (or set BOTCORD_HERMES_AGENT_BIN to the absolute path of hermes-acp)',
};

/** Built-in runtime module entry for Gemini CLI. */
export const geminiModule: RuntimeModule = {
  id: "gemini",
  displayName: "Gemini CLI",
  binary: "gemini",
  envVar: "BOTCORD_GEMINI_BIN",
  probe: () => probeGemini(),
  create: () => new GeminiAdapter(),
  installHint:
    "Install with `npm install -g @google/gemini-cli` (or `brew install gemini-cli`) and run `gemini` once to complete authentication. Override the binary with BOTCORD_GEMINI_BIN.",
  update: { kind: "npm", pkg: "@google/gemini-cli" },
};

/** Built-in runtime module entry for OpenClaw (ACP). */
export const openclawAcpModule: RuntimeModule = {
  id: "openclaw-acp",
  displayName: "OpenClaw (ACP)",
  binary: "openclaw",
  envVar: "BOTCORD_OPENCLAW_BIN",
  probe: () => probeOpenclaw(),
  create: () => new OpenclawAcpAdapter(),
  // --no-restart: the daemon must never bounce a user's openclaw gateway
  // service as a side effect; the new version applies on next restart.
  update: { kind: "self", args: ["update", "--yes", "--no-restart"] },
};

/**
 * Built-in runtime modules. To add a new runtime:
 *   1. Create `runtimes/<name>.ts` extending `NdjsonStreamAdapter` (or
 *      implementing `RuntimeAdapter` directly).
 *   2. Add a `RuntimeModule` entry + register it here.
 */
export const RUNTIME_MODULES: readonly RuntimeModule[] = [
  claudeCodeModule,
  codexModule,
  deepseekTuiModule,
  kimiModule,
  hermesAgentModule,
  geminiModule,
  openclawAcpModule,
];

const BY_ID = new Map<string, RuntimeModule>(
  RUNTIME_MODULES.map((m) => [m.id, m]),
);

/** Lookup a runtime module by id, or null when the id is unknown. */
export function getRuntimeModule(id: string): RuntimeModule | null {
  return BY_ID.get(id) ?? null;
}

/** All registered runtime ids in registration order. */
export function listRuntimeIds(): string[] {
  return RUNTIME_MODULES.map((m) => m.id);
}

/** Env var name used to override the binary path for a given runtime id. */
export function envVarForRuntime(id: string): string {
  const mod = getRuntimeModule(id);
  if (mod?.envVar) return mod.envVar;
  const token = id.replace(/-/g, "_").toUpperCase();
  return `BOTCORD_${token}_BIN`;
}

/** Instantiate a single runtime adapter by id; throws if unknown. */
export function createRuntime(id: string): RuntimeAdapter {
  const mod = getRuntimeModule(id);
  if (!mod) {
    throw new Error(
      `Unknown runtime "${id}". Registered runtimes: ${listRuntimeIds().join(", ")}`,
    );
  }
  return mod.create();
}

/** Instantiate every registered runtime — used as the dispatcher default. */
export function createAllRuntimes(): Record<string, RuntimeAdapter> {
  const map: Record<string, RuntimeAdapter> = {};
  for (const m of RUNTIME_MODULES) {
    map[m.id] = m.create();
  }
  return map;
}

/** One probe result per registered runtime, for `doctor`-style listings. */
export interface RuntimeProbeEntry {
  id: string;
  displayName: string;
  binary: string;
  supportsRun: boolean;
  result: RuntimeProbeResult;
  installHint?: string;
}

/** Probe every registered runtime and report installation status. */
export function detectRuntimes(): RuntimeProbeEntry[] {
  const out: RuntimeProbeEntry[] = [];
  for (const m of RUNTIME_MODULES) {
    let result: RuntimeProbeResult = { available: false };
    try {
      result = m.probe();
    } catch {
      result = { available: false };
    }
    out.push({
      id: m.id,
      displayName: m.displayName,
      binary: m.binary,
      supportsRun: m.supportsRun !== false,
      result,
      installHint: m.installHint,
    });
  }
  return out;
}
