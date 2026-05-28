import { NdjsonStreamAdapter, type NdjsonEventCtx } from "./ndjson-stream.js";
import {
  readCommandVersion,
  resolveCommandOnPath,
  type ProbeDeps,
} from "./probe.js";
import type {
  RuntimeProbeResult,
  RuntimeRunOptions,
  RuntimeStatusEvent,
  StreamBlock,
} from "../types.js";

/**
 * Gemini's `--session-id` / `--resume` accept only `[A-Za-z0-9-_]+` and we
 * forward whatever the CLI emitted in its `init` event. Rejecting anything
 * else keeps argv safe even if the upstream session id format ever changes.
 */
const GEMINI_SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

function isValidGeminiSessionId(id: string): boolean {
  return GEMINI_SESSION_ID_RE.test(id);
}

function invalidGeminiSessionIdError(id: string): string {
  return `gemini: invalid sessionId ${JSON.stringify(id)} (expected [A-Za-z0-9_-]+)`;
}

/**
 * Drop adapter-foreign flags inherited from other runtimes' route configs
 * (claude-code, codex). Each entry that takes a value also swallows the
 * value that follows. Anything else is forwarded verbatim so operators can
 * still push gemini-native flags through.
 */
const GEMINI_FOREIGN_FLAGS_WITH_VALUE = new Set([
  "--append-system-prompt",
  "--permission-mode",
  "--setting-sources",
  "--sandbox",
  "-c",
]);
const GEMINI_FOREIGN_BOOLEAN_FLAGS = new Set([
  "--dangerously-bypass-approvals-and-sandbox",
  "--full-auto",
  "--skip-git-repo-check",
  "--json",
  "--verbose",
]);

function extraFlagName(arg: string): string {
  if (!arg.startsWith("-")) return arg;
  const eq = arg.indexOf("=");
  return eq === -1 ? arg : arg.slice(0, eq);
}

function nextExtraValue(args: string[], index: number): string | undefined {
  const next = args[index + 1];
  if (typeof next !== "string") return undefined;
  if (!next.startsWith("-")) return next;
  return /^-\d/.test(next) ? next : undefined;
}

function sanitizeGeminiExtraArgs(extraArgs: string[] | undefined): string[] {
  if (!extraArgs?.length) return [];
  const out: string[] = [];
  for (let i = 0; i < extraArgs.length; i += 1) {
    const arg = extraArgs[i];
    const name = extraFlagName(arg);
    if (GEMINI_FOREIGN_FLAGS_WITH_VALUE.has(name)) {
      if (!arg.includes("=") && nextExtraValue(extraArgs, i) !== undefined) i += 1;
      continue;
    }
    if (GEMINI_FOREIGN_BOOLEAN_FLAGS.has(name)) {
      continue;
    }
    out.push(arg);
  }
  return out;
}

function hasFlag(args: string[], name: string): boolean {
  for (const arg of args) {
    if (arg === name) return true;
    if (arg.startsWith(`${name}=`)) return true;
  }
  return false;
}

/** Resolve the Gemini CLI executable on PATH. */
export function resolveGeminiCommand(deps: ProbeDeps = {}): string | null {
  return resolveCommandOnPath("gemini", deps);
}

/** Probe whether the Gemini CLI is installed and report its version. */
export function probeGemini(deps: ProbeDeps = {}): RuntimeProbeResult {
  const command = resolveGeminiCommand(deps);
  if (!command) return { available: false };
  return {
    available: true,
    path: command,
    version: readCommandVersion(command, [], deps) ?? undefined,
  };
}

/**
 * Gemini adapter — spawns `gemini -p "<text>" --output-format stream-json
 * --yolo` (with `--resume <sid>` for continuing sessions) and parses the
 * newline-delimited JSON stream.
 *
 * stream-json event shape (abridged, sourced from `@google/gemini-cli`
 * bundle `nonInteractiveCliAgentSession.ts`):
 *
 *   {type:"init", timestamp, session_id, model}
 *   {type:"message", timestamp, role:"user", content}            // echo of input
 *   {type:"message", timestamp, role:"assistant", content, delta:true}
 *   {type:"tool_use", timestamp, tool_name, tool_id, parameters}
 *   {type:"tool_result", timestamp, tool_id, status, output?, error?}
 *   {type:"error", timestamp, severity, message}                 // non-fatal warning
 *   {type:"result", timestamp, status:"success", stats}          // terminal
 *   {type:"result", timestamp, status:"error", error:{type,message}, stats}
 *
 * Unlike Claude Code's `result` event, gemini's terminal event carries NO
 * final assistant text — the reply must be assembled by concatenating every
 * `message` event with `role:"assistant"` (the CLI emits them as deltas).
 *
 * ## systemContext
 *
 * Gemini's headless mode has no `--append-system-prompt` equivalent and
 * `GEMINI_SYSTEM_MD` replaces the entire core system prompt (which would
 * brick the agent — that core prompt scaffolds tool use). For v1 the
 * adapter prepends `systemContext` directly to the positional prompt. Each
 * turn re-injects the dynamic context so memory / digest updates take
 * effect immediately; the trade-off is the resumed session transcript
 * accumulates one prompt prefix per turn. Acceptable while we ship the
 * connectivity layer — a follow-up can move systemContext into a
 * daemon-managed `GEMINI.md` once we decide where to isolate it.
 *
 * ## Session continuity
 *
 * `gemini --session-id <uuid>` is for FRESH sessions only — it errors if
 * the id already exists. `gemini --resume <uuid>` resolves the UUID against
 * the project's existing session pool (gemini stores sessions per
 * cwd-derived project hash, so the per-agent workspace already isolates
 * them from the user's interactive sessions). We therefore:
 *   - new turn (sessionId=null): omit both flags; capture `init.session_id`.
 *   - continuation: pass `--resume <uuid>`. If gemini cannot resolve the id
 *     it exits with `FATAL_INPUT_ERROR` and stderr; we surface that as
 *     `errorText` and wipe `newSessionId` so the dispatcher discards the
 *     stale entry.
 */
export class GeminiAdapter extends NdjsonStreamAdapter {
  readonly id = "gemini" as const;

  private readonly explicitBinary: string | undefined;
  private resolvedBinary: string | null = null;

  constructor(opts?: { binary?: string }) {
    super();
    this.explicitBinary = opts?.binary ?? process.env.BOTCORD_GEMINI_BIN;
  }

  probe(): RuntimeProbeResult {
    return probeGemini();
  }

  override async run(opts: RuntimeRunOptions) {
    if (opts.sessionId && !isValidGeminiSessionId(opts.sessionId)) {
      throw new Error(invalidGeminiSessionIdError(opts.sessionId));
    }
    return super.run(opts);
  }

  protected resolveBinary(): string {
    if (this.explicitBinary) return this.explicitBinary;
    if (this.resolvedBinary) return this.resolvedBinary;
    this.resolvedBinary = resolveGeminiCommand() ?? "gemini";
    return this.resolvedBinary;
  }

  protected buildArgs(opts: RuntimeRunOptions): string[] {
    const extraArgs = sanitizeGeminiExtraArgs(opts.extraArgs);

    const args: string[] = [
      "-p",
      composePrompt(opts.text, opts.systemContext),
      "--output-format",
      "stream-json",
    ];

    // Daemon-driven gemini turns are non-interactive. Auto-approve all tool
    // use to avoid deadlocks; operators with stricter requirements can
    // override via extraArgs `--approval-mode plan` etc.
    if (
      !hasFlag(extraArgs, "--approval-mode") &&
      !hasFlag(extraArgs, "-y") &&
      !hasFlag(extraArgs, "--yolo")
    ) {
      args.push("--yolo");
    }

    // Trust the workspace so gemini doesn't downgrade the approval mode the
    // moment cwd isn't in `~/.gemini/trustedFolders.json`. Without this the
    // CLI silently flips back to "default" approval — which then deadlocks
    // on tool calls because we have no prompt relay.
    if (!hasFlag(extraArgs, "--skip-trust")) {
      args.push("--skip-trust");
    }

    if (opts.sessionId) {
      if (!isValidGeminiSessionId(opts.sessionId)) {
        throw new Error(invalidGeminiSessionIdError(opts.sessionId));
      }
      args.push("--resume", opts.sessionId);
    }

    if (extraArgs.length) args.push(...extraArgs);
    return args;
  }

  protected override spawnEnv(opts: RuntimeRunOptions): NodeJS.ProcessEnv {
    return {
      ...super.spawnEnv(opts),
      // Keep stream-json clean regardless of the user's terminal settings.
      FORCE_COLOR: "0",
      NO_COLOR: "1",
      // Prevent gemini's launcher from re-spawning itself with --max-old-space
      // tuning; the relaunch races with our stdio piping in tests and shaves
      // ~200ms off every spawn in production.
      GEMINI_CLI_NO_RELAUNCH: "1",
    };
  }

  protected handleEvent(raw: unknown, ctx: NdjsonEventCtx): void {
    const obj = raw as {
      type?: string;
      session_id?: string;
      role?: string;
      content?: string;
      delta?: boolean;
      tool_name?: string;
      tool_id?: string;
      status?: string;
      severity?: string;
      message?: string;
      error?: { type?: string; message?: string };
    };

    const status = geminiStatusEvent(obj);
    if (status) ctx.emitStatus(status);

    ctx.emitBlock(normalizeBlock(obj, ctx.seq));

    if (obj.type === "init" && typeof obj.session_id === "string") {
      ctx.state.newSessionId = obj.session_id;
      return;
    }

    if (obj.type === "message" && obj.role === "assistant" && typeof obj.content === "string") {
      ctx.appendAssistantText(obj.content);
      return;
    }

    if (obj.type === "result") {
      if (obj.status === "error") {
        const errMsg = obj.error?.message;
        ctx.state.errorText =
          typeof errMsg === "string" && errMsg ? errMsg : "gemini run failed";
        // Drop the captured session id so the dispatcher doesn't try to
        // resume a session that may not have been persisted to disk.
        ctx.state.newSessionId = "";
        ctx.state.finalText = "";
        ctx.state.assistantTextChunks = [];
        ctx.state.assistantTextBytes = 0;
      }
      return;
    }

    if (obj.type === "error" && obj.severity === "error" && typeof obj.message === "string") {
      // Severity "error" is fatal in gemini's classification; "warning" is
      // recoverable and shouldn't override the assistant's output.
      ctx.state.errorText = obj.message;
    }
  }
}

/**
 * Prepend systemContext to the user prompt. Empty systemContext (the common
 * case for direct DMs) returns the prompt unchanged so we don't bloat the
 * token count with a marker prefix that conveys nothing.
 */
function composePrompt(text: string, systemContext: string | undefined): string {
  if (!systemContext || !systemContext.trim()) return text;
  return `${systemContext.trim()}\n\n---\n\n${text}`;
}

/**
 * Map a gemini stream-json event to a `RuntimeStatusEvent`. Only the
 * lifecycle transitions the dispatcher can't infer from `StreamBlock.kind`
 * land here; everything else is left to auto-synthesis.
 */
function geminiStatusEvent(obj: {
  type?: string;
  role?: string;
  delta?: boolean;
  status?: string;
  tool_name?: string;
}): RuntimeStatusEvent | undefined {
  if (obj.type === "init") {
    return { kind: "thinking", phase: "started", label: "Starting session" };
  }
  if (obj.type === "tool_use") {
    const name = typeof obj.tool_name === "string" && obj.tool_name ? obj.tool_name : "tool";
    return { kind: "thinking", phase: "updated", label: name };
  }
  if (obj.type === "message" && obj.role === "assistant") {
    return { kind: "thinking", phase: "stopped" };
  }
  if (obj.type === "result") {
    return { kind: "thinking", phase: "stopped" };
  }
  return undefined;
}

function normalizeBlock(obj: any, seq: number): StreamBlock {
  let kind: StreamBlock["kind"] = "other";
  const type: string | undefined = obj?.type;
  if (type === "message" && obj?.role === "assistant") {
    kind = "assistant_text";
  } else if (type === "tool_use") {
    kind = "tool_use";
  } else if (type === "tool_result") {
    kind = "tool_result";
  } else if (type === "init" || type === "result") {
    kind = "system";
  }
  return { raw: obj, kind, seq };
}
