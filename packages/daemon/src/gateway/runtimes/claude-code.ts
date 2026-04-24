import path from "node:path";
import { NdjsonStreamAdapter, type NdjsonEventCtx } from "./ndjson-stream.js";
import {
  firstExistingPath,
  readCommandVersion,
  resolveCommandOnPath,
  resolveHomePath,
  type ProbeDeps,
} from "./probe.js";
import type { RuntimeProbeResult, RuntimeRunOptions, StreamBlock } from "../types.js";

const CLAUDE_DESKTOP_CLI_RELATIVE_PATH = path.join(
  "Applications",
  "Claude Code URL Handler.app",
  "Contents",
  "MacOS",
  "claude",
);
const CLAUDE_DESKTOP_CLI_SYSTEM_PATH =
  "/Applications/Claude Code URL Handler.app/Contents/MacOS/claude";
function isValidClaudeSessionId(sessionId: string): boolean {
  if (sessionId.length === 0 || sessionId.length > 512) return false;
  if (sessionId.startsWith("-")) return false;
  for (const ch of sessionId) {
    const code = ch.codePointAt(0);
    if (code === undefined || code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

function invalidClaudeSessionIdError(): string {
  return "claude-code: invalid sessionId (expected non-control text not starting with '-')";
}

/** Resolve the Claude Code CLI path on PATH or the macOS desktop bundle fallback. */
export function resolveClaudeCommand(deps: ProbeDeps = {}): string | null {
  const onPath = resolveCommandOnPath("claude", deps);
  if (onPath) return onPath;
  if ((deps.platform ?? process.platform) !== "darwin") return null;
  return firstExistingPath(
    [resolveHomePath(CLAUDE_DESKTOP_CLI_RELATIVE_PATH, deps), CLAUDE_DESKTOP_CLI_SYSTEM_PATH],
    deps,
  );
}

/** Probe whether the Claude Code CLI is installed and report its version. */
export function probeClaude(deps: ProbeDeps = {}): RuntimeProbeResult {
  const command = resolveClaudeCommand(deps);
  if (!command) return { available: false };
  return {
    available: true,
    path: command,
    version: readCommandVersion(command, [], deps) ?? undefined,
  };
}

/**
 * Claude Code adapter — spawns `claude -p "<text>" --output-format stream-json`
 * (with `--resume <sid>` when available) and parses the ndjson stream.
 *
 * stream-json shape (abridged):
 *   {type:"system", subtype:"init", session_id:"...", ...}
 *   {type:"assistant", message:{content:[{type:"text", text:"..."} | {type:"tool_use", ...}]}}
 *   {type:"user", message:{content:[{type:"tool_result", ...}]}}
 *   {type:"result", subtype:"success", session_id:"...", total_cost_usd: 0.01, result:"final text"}
 */
export class ClaudeCodeAdapter extends NdjsonStreamAdapter {
  readonly id = "claude-code" as const;

  private readonly explicitBinary: string | undefined;
  private resolvedBinary: string | null = null;

  constructor(opts?: { binary?: string }) {
    super();
    this.explicitBinary = opts?.binary ?? process.env.BOTCORD_CLAUDE_BIN;
  }

  probe(): RuntimeProbeResult {
    return probeClaude();
  }

  override async run(opts: RuntimeRunOptions) {
    if (opts.sessionId && !isValidClaudeSessionId(opts.sessionId)) {
      return { text: "", newSessionId: "", error: invalidClaudeSessionIdError() };
    }
    return super.run(opts);
  }

  protected resolveBinary(): string {
    if (this.explicitBinary) return this.explicitBinary;
    if (this.resolvedBinary) return this.resolvedBinary;
    // Falls back to the macOS Claude Code URL Handler bundle when not on PATH.
    this.resolvedBinary = resolveClaudeCommand() ?? "claude";
    return this.resolvedBinary;
  }

  protected buildArgs(opts: RuntimeRunOptions): string[] {
    const args = ["-p", opts.text, "--output-format", "stream-json", "--verbose"];
    // Headless `-p` mode does not load project `.claude/` by default, so
    // per-agent skills seeded at `<workspace>/.claude/skills/` are invisible
    // unless we opt in. `extraArgs` wins so operators can still override.
    if (!opts.extraArgs?.some((a) => a.startsWith("--setting-sources"))) {
      args.push("--setting-sources", "project");
    }
    if (opts.sessionId) {
      if (!isValidClaudeSessionId(opts.sessionId)) throw new Error(invalidClaudeSessionIdError());
      args.push("--resume", opts.sessionId);
    }
    // Permission-mode policy:
    //  - owner: acceptEdits (owner trusts their own agent).
    //  - non-owner (trusted/public): default (let Claude Code prompt / reject edits per its own rules).
    // `extraArgs` still wins — operators who know what they're doing can override either.
    if (!opts.extraArgs?.some((a) => a.startsWith("--permission-mode"))) {
      if (opts.trustLevel === "owner") {
        args.push("--permission-mode", "acceptEdits");
      } else {
        args.push("--permission-mode", "default");
      }
    }
    // Claude Code's `--append-system-prompt` is applied per invocation and NOT
    // persisted in the resumed session transcript — ideal for memory / digest
    // content that should re-evaluate every turn.
    if (opts.systemContext && !opts.extraArgs?.includes("--append-system-prompt")) {
      args.push("--append-system-prompt", opts.systemContext);
    }
    if (opts.extraArgs?.length) args.push(...opts.extraArgs);
    return args;
  }

  protected handleEvent(raw: unknown, ctx: NdjsonEventCtx): void {
    const obj = raw as {
      type?: string;
      subtype?: string;
      session_id?: string;
      total_cost_usd?: number;
      result?: string;
      message?: { content?: Array<{ type?: string; text?: string }> };
    };

    ctx.emitBlock(normalizeBlock(obj, ctx.seq));

    if (obj.type === "system" && obj.session_id) {
      ctx.state.newSessionId = String(obj.session_id);
      return;
    }
    if (obj.type === "assistant" && Array.isArray(obj.message?.content)) {
      for (const c of obj.message.content) {
        if (c?.type === "text" && typeof c.text === "string") {
          ctx.appendAssistantText(c.text);
        }
      }
      return;
    }
    if (obj.type === "result") {
      if (typeof obj.total_cost_usd === "number") ctx.state.costUsd = obj.total_cost_usd;
      if (obj.subtype === "success") {
        if (typeof obj.session_id === "string") ctx.state.newSessionId = obj.session_id;
        if (typeof obj.result === "string") ctx.state.finalText = obj.result;
      } else {
        // Non-success result (e.g. resume targeted a missing UUID). Claude Code
        // still emits a fresh `session_id` for the just-spawned empty session —
        // persisting it would trap us into resuming a useless UUID forever.
        // Wipe newSessionId so the dispatcher deletes the stale entry instead.
        // The CLI also exits non-zero, so the base adapter synthesizes errorText
        // from stderr if `obj.result` is missing.
        ctx.state.newSessionId = "";
        if (typeof obj.result === "string") ctx.state.errorText = obj.result;
      }
    }
  }
}

function normalizeBlock(obj: any, seq: number): StreamBlock {
  let kind: StreamBlock["kind"] = "other";
  if (obj?.type === "assistant") {
    const contents = Array.isArray(obj.message?.content) ? obj.message.content : [];
    if (contents.some((c: any) => c?.type === "tool_use")) kind = "tool_use";
    else if (contents.some((c: any) => c?.type === "text")) kind = "assistant_text";
  } else if (obj?.type === "user") {
    const contents = Array.isArray(obj.message?.content) ? obj.message.content : [];
    if (contents.some((c: any) => c?.type === "tool_result")) kind = "tool_result";
  } else if (obj?.type === "system") {
    kind = "system";
  }
  return { raw: obj, kind, seq };
}
