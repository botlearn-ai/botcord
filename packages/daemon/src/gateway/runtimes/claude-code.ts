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
    // Daemon-driven Claude Code runs are non-interactive. Any mode that waits
    // for a local permission prompt can deadlock tool use (Bash / WebFetch /
    // MCP) because there is no prompt relay back to the user yet. Default to
    // bypassPermissions for every trust tier; operators who need a stricter
    // posture can still override with route/defaultRoute extraArgs.
    if (!opts.extraArgs?.some((a) => a.startsWith("--permission-mode"))) {
      args.push("--permission-mode", "bypassPermissions");
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
      message?: { content?: Array<{ type?: string; text?: string; name?: string }> };
    };

    // Emit a thinking lifecycle hint BEFORE the block so the dispatcher's
    // auto-synthesis short-circuits (we provide a labeled event instead).
    const status = claudeStatusEvent(obj);
    if (status) ctx.emitStatus(status);

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

/**
 * Map a Claude Code stream-json event to a `RuntimeStatusEvent`. We only
 * return events for transitions the dispatcher cannot infer from block kinds
 * alone — the auto-synthesis path covers the unlabeled case.
 *
 * Note: Claude Code's `assistant` events sometimes mix `text` and `tool_use`
 * blocks. When `text` is present we treat it as "thinking stopped"; when
 * `tool_use` is present without `text` we surface the tool name as a label.
 */
function claudeStatusEvent(obj: {
  type?: string;
  subtype?: string;
  message?: { content?: Array<{ type?: string; text?: string; name?: string }> };
}): import("../types.js").RuntimeStatusEvent | undefined {
  if (obj.type === "system" && obj.subtype === "init") {
    return { kind: "thinking", phase: "started", label: "Starting session" };
  }
  if (obj.type === "assistant" && Array.isArray(obj.message?.content)) {
    const contents = obj.message.content;
    const hasText = contents.some(
      (c) => c?.type === "text" && typeof c.text === "string" && c.text.length > 0,
    );
    if (hasText) return { kind: "thinking", phase: "stopped" };
    const tool = contents.find((c) => c?.type === "tool_use");
    if (tool) {
      const name = typeof tool.name === "string" && tool.name ? tool.name : "tool";
      return { kind: "thinking", phase: "updated", label: name };
    }
  }
  if (obj.type === "result") {
    return { kind: "thinking", phase: "stopped" };
  }
  return undefined;
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
