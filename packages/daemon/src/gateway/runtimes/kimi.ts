import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { writeManagedSystemRulesFile } from "../../system-rules.js";
import { buildCliEnv } from "../cli-resolver.js";
import { NdjsonStreamAdapter, type NdjsonEventCtx } from "./ndjson-stream.js";
import {
  readCommandVersion,
  resolveCommandOnPath,
  type ProbeDeps,
} from "./probe.js";
import type { RuntimeProbeResult, RuntimeRunOptions, StreamBlock } from "../types.js";

function isValidKimiSessionId(sessionId: string): boolean {
  if (sessionId.length === 0 || sessionId.length > 512) return false;
  if (sessionId.startsWith("-")) return false;
  for (const ch of sessionId) {
    const code = ch.codePointAt(0);
    if (code === undefined || code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

function invalidKimiSessionIdError(): string {
  return "kimi-cli: invalid sessionId (expected non-control text not starting with '-')";
}

const KIMI_EXTRA_FLAGS_WITH_VALUE = new Set([
  "--add-dir",
  "--agent",
  "--agent-file",
  "--config",
  "--config-file",
  "--max-ralph-iterations",
  "--max-retries-per-step",
  "--max-steps-per-turn",
  "--mcp-config",
  "--mcp-config-file",
  "--model",
  "--skills-dir",
  "-m",
]);

const KIMI_EXTRA_BOOLEAN_FLAGS = new Set([
  "--afk",
  "--auto-approve",
  "--debug",
  "--no-thinking",
  "--plan",
  "--thinking",
  "--verbose",
  "--yes",
  "--yolo",
  "-y",
]);

// Flags owned by the adapter because BotCord depends on Kimi's non-interactive
// stream-json contract, cwd isolation, prompt placement, and session routing.
const KIMI_ADAPTER_OWNED_FLAGS = new Set([
  "--acp",
  "--command",
  "--continue",
  "--final-message-only",
  "--help",
  "--input-format",
  "--output-format",
  "--print",
  "--prompt",
  "--quiet",
  "--resume",
  "--session",
  "--version",
  "--wire",
  "--work-dir",
  "-C",
  "-S",
  "-V",
  "-c",
  "-h",
  "-p",
  "-r",
  "-w",
]);

const kimiWorkDirSupport = new Map<string, boolean>();

function flagName(arg: string): string {
  if (!arg.startsWith("-")) return arg;
  const eq = arg.indexOf("=");
  return eq === -1 ? arg : arg.slice(0, eq);
}

function nextValue(args: string[], index: number): string | undefined {
  const next = args[index + 1];
  if (typeof next !== "string") return undefined;
  if (!next.startsWith("-")) return next;
  return /^-\d/.test(next) ? next : undefined;
}

function sanitizeKimiExtraArgs(extraArgs: string[] | undefined): string[] {
  if (!extraArgs?.length) return [];
  const out: string[] = [];
  for (let i = 0; i < extraArgs.length; i += 1) {
    const arg = extraArgs[i];
    const name = flagName(arg);

    if (KIMI_ADAPTER_OWNED_FLAGS.has(name)) {
      if (!arg.includes("=") && nextValue(extraArgs, i) !== undefined) i += 1;
      continue;
    }

    if (KIMI_EXTRA_FLAGS_WITH_VALUE.has(name)) {
      if (arg.includes("=")) {
        out.push(arg);
        continue;
      }
      const value = nextValue(extraArgs, i);
      if (value !== undefined) {
        out.push(arg, value);
        i += 1;
      }
      continue;
    }

    if (KIMI_EXTRA_BOOLEAN_FLAGS.has(name)) {
      out.push(arg);
      continue;
    }

    if (arg.startsWith("-") && !arg.includes("=") && nextValue(extraArgs, i) !== undefined) {
      i += 1;
    }
  }
  return out;
}

function parseKimiVersionMajor(version: string | null): number | null {
  const match = version?.match(/\b(\d+)\.(\d+)\.(\d+)\b/);
  if (!match) return null;
  return Number.parseInt(match[1], 10);
}

function probeKimiSupportsWorkDir(command: string): boolean {
  const cached = kimiWorkDirSupport.get(command);
  if (cached !== undefined) return cached;

  let supported = false;
  try {
    const help = execFileSync(command, ["--help"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5000,
    });
    supported = /(?:^|\s)--work-dir(?:[=\s,]|$)/.test(help);
  } catch {
    const major = parseKimiVersionMajor(readCommandVersion(command));
    supported = major !== null && major >= 1;
  }

  kimiWorkDirSupport.set(command, supported);
  return supported;
}

/** Resolve the Kimi CLI executable on PATH. */
export function resolveKimiCommand(deps: ProbeDeps = {}): string | null {
  return resolveCommandOnPath("kimi", deps);
}

/** Probe whether the Kimi CLI is installed and report its version. */
export function probeKimi(deps: ProbeDeps = {}): RuntimeProbeResult {
  const command = resolveKimiCommand(deps);
  if (!command) return { available: false };
  return {
    available: true,
    path: command,
    version: readCommandVersion(command, [], deps) ?? undefined,
  };
}

/**
 * Kimi CLI adapter — spawns:
 *
 *   kimi [--work-dir <cwd>] --print --output-format stream-json --session <sid> --afk --prompt <text>
 *
 * `--session <sid>` resumes an existing session or creates a new session with
 * that id, so the adapter generates a UUID on first turn and persists it for
 * later turns. Kimi does not expose a Codex-style per-invocation AGENTS.md
 * carrier, so dynamic `systemContext` is sent as a system-reminder prefix on
 * the user prompt. Stable BotCord `systemRules` (room rules) are written to
 * `<cwd>/.kimi/AGENTS.md` before spawn; Kimi freezes the system prompt per
 * session, so rule updates may require a fresh session to take effect.
 */
export class KimiAdapter extends NdjsonStreamAdapter {
  readonly id = "kimi-cli" as const;

  private readonly explicitBinary: string | undefined;
  private resolvedBinary: string | null = null;

  constructor(opts?: { binary?: string }) {
    super();
    this.explicitBinary = opts?.binary ?? process.env.BOTCORD_KIMI_CLI_BIN;
  }

  probe(): RuntimeProbeResult {
    return probeKimi();
  }

  override async run(opts: RuntimeRunOptions) {
    if (opts.sessionId && !isValidKimiSessionId(opts.sessionId)) {
      return { text: "", newSessionId: "", error: invalidKimiSessionIdError() };
    }
    writeKimiSystemRules(opts);
    const sessionId = opts.sessionId || randomUUID();
    return super.run({ ...opts, sessionId });
  }

  protected resolveBinary(): string {
    if (this.explicitBinary) return this.explicitBinary;
    if (this.resolvedBinary) return this.resolvedBinary;
    this.resolvedBinary = resolveKimiCommand() ?? "kimi";
    return this.resolvedBinary;
  }

  protected buildArgs(opts: RuntimeRunOptions): string[] {
    const sessionId = opts.sessionId || randomUUID();
    if (!isValidKimiSessionId(sessionId)) throw new Error(invalidKimiSessionIdError());

    const args = [
      "--print",
      "--output-format",
      "stream-json",
      "--session",
      sessionId,
      "--afk",
    ];
    if (probeKimiSupportsWorkDir(this.resolveBinary())) args.unshift("--work-dir", opts.cwd);
    args.push(...sanitizeKimiExtraArgs(opts.extraArgs));
    args.push("--prompt", promptWithSystemContext(opts.text, opts.systemContext));
    return args;
  }

  protected spawnEnv(opts: RuntimeRunOptions): NodeJS.ProcessEnv {
    const cliEnv = buildCliEnv({
      hubUrl: opts.hubUrl,
      accountId: opts.accountId,
      basePath: process.env.PATH,
      waitMarkerFile: opts.waitMarkerFile,
    });
    return {
      ...process.env,
      ...cliEnv,
      FORCE_COLOR: "0",
      NO_COLOR: "1",
    };
  }

  protected handleEvent(raw: unknown, ctx: NdjsonEventCtx): void {
    const obj = raw as KimiStreamJsonEvent;

    const status = kimiStatusEvent(obj);
    if (status) ctx.emitStatus(status);

    ctx.emitBlock(normalizeBlock(obj, ctx.seq));

    const sessionId = kimiSessionId(obj);
    if (sessionId) ctx.state.newSessionId = sessionId;

    if (obj.role === "assistant") {
      const text = extractText(obj.content);
      if (text) {
        ctx.appendAssistantText(text);
        ctx.state.finalText = text;
      }
      return;
    }

    const err = kimiErrorText(obj);
    if (err) ctx.state.errorText = err;
  }
}

type KimiContentPart = {
  type?: string;
  text?: string;
  think?: string;
};

type KimiToolCall = {
  id?: string;
  function?: { name?: string; arguments?: string | null };
};

type KimiStreamJsonEvent = {
  role?: string;
  content?: string | KimiContentPart[] | null;
  tool_calls?: KimiToolCall[] | null;
  tool_call_id?: string | null;
  content_type?: string;
  file_path?: string;
  session_id?: string;
  id?: string;
  category?: string;
  type?: string;
  title?: string;
  body?: string;
  severity?: string;
  error?: string | { message?: string };
  message?: string;
};

function promptWithSystemContext(text: string, systemContext: string | undefined): string {
  if (!systemContext) return text;
  return `<system-reminder>\n${systemContext}\n</system-reminder>\n\n${text}`;
}

function writeKimiSystemRules(opts: RuntimeRunOptions): void {
  if (!opts.systemRules?.length) return;
  try {
    writeManagedSystemRulesFile(path.join(opts.cwd, ".kimi", "AGENTS.md"), opts.systemRules);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("kimi-cli: failed to write BotCord system rules to .kimi/AGENTS.md", err);
  }
}

function extractText(content: KimiStreamJsonEvent["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
}

function hasThinking(content: KimiStreamJsonEvent["content"]): boolean {
  return Array.isArray(content)
    ? content.some((part) => part?.type === "think" && typeof part.think === "string" && part.think)
    : false;
}

function firstToolName(toolCalls: KimiToolCall[] | null | undefined): string {
  const name = toolCalls?.find((t) => typeof t.function?.name === "string")?.function?.name;
  return name || "tool";
}

function kimiSessionId(obj: KimiStreamJsonEvent): string | undefined {
  return typeof obj.session_id === "string" && obj.session_id ? obj.session_id : undefined;
}

function kimiErrorText(obj: KimiStreamJsonEvent): string | undefined {
  if (typeof obj.error === "string" && obj.error) return obj.error;
  if (obj.error && typeof obj.error === "object") {
    const message = obj.error.message;
    if (typeof message === "string" && message) return message;
  }
  if (obj.type === "error" && typeof obj.message === "string" && obj.message) {
    return obj.message;
  }
  if (obj.severity === "error") {
    return [obj.title, obj.body].filter(Boolean).join(": ") || "kimi-cli error";
  }
  return undefined;
}

function kimiStatusEvent(
  obj: KimiStreamJsonEvent,
): import("../types.js").RuntimeStatusEvent | undefined {
  if (obj.role === "assistant" && hasThinking(obj.content)) {
    return { kind: "thinking", phase: "started", label: "Thinking" };
  }
  if (obj.role === "assistant" && obj.tool_calls?.length) {
    return { kind: "thinking", phase: "updated", label: firstToolName(obj.tool_calls) };
  }
  if (obj.role === "assistant" && extractText(obj.content)) {
    return { kind: "thinking", phase: "stopped" };
  }
  if (obj.role === "tool") {
    return { kind: "thinking", phase: "updated", label: "Tool result" };
  }
  return undefined;
}

function normalizeBlock(obj: KimiStreamJsonEvent, seq: number): StreamBlock {
  let kind: StreamBlock["kind"] = "other";
  if (obj.role === "assistant") {
    if (obj.tool_calls?.length) kind = "tool_use";
    else if (extractText(obj.content)) kind = "assistant_text";
    else if (hasThinking(obj.content)) kind = "other";
  } else if (obj.role === "tool") {
    kind = "tool_result";
  } else if (obj.file_path && typeof obj.content === "string") {
    kind = "other";
  } else if (obj.category || obj.severity) {
    kind = "system";
  }
  return { raw: obj, kind, seq };
}
