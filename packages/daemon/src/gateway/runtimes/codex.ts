import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { agentCodexHomeDir, ensureAgentCodexHome } from "../../agent-workspace.js";
import { buildCliEnv } from "../cli-resolver.js";
import { NdjsonStreamAdapter, type NdjsonEventCtx } from "./ndjson-stream.js";
import {
  firstExistingPath,
  readCommandVersion,
  resolveCommandOnPath,
  type ProbeDeps,
} from "./probe.js";
import type { RuntimeProbeResult, RuntimeRunOptions, StreamBlock } from "../types.js";

const CODEX_DESKTOP_BUNDLE_PATH = "/Applications/Codex.app/Contents/Resources/codex";
/** Codex UUIDv7 / v4 session ids are 36-char dashed hex; reject anything else to keep argv safe. */
const CODEX_SESSION_ID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** Resolve the Codex CLI executable via PATH or macOS desktop bundle. */
export function resolveCodexCommand(deps: ProbeDeps = {}): string | null {
  const onPath = resolveCommandOnPath("codex", deps);
  if (onPath) return onPath;
  return firstExistingPath([CODEX_DESKTOP_BUNDLE_PATH], deps);
}

function resolveCodexGlobalNpmEntry(): string | null {
  try {
    const globalRoot = execFileSync("npm", ["root", "-g"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    }).trim();
    if (!globalRoot) return null;
    const candidate = path.join(globalRoot, "@openai", "codex", "bin", "codex.js");
    return existsSync(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

/** Probe whether the Codex CLI is installed and report its version. */
export function probeCodex(deps: ProbeDeps = {}): RuntimeProbeResult {
  const command = resolveCodexCommand(deps);
  if (command) {
    return {
      available: true,
      path: command,
      version: readCommandVersion(command, [], deps) ?? undefined,
    };
  }
  const npmEntry = resolveCodexGlobalNpmEntry();
  if (npmEntry) {
    return {
      available: true,
      path: npmEntry,
      version: readCommandVersion(process.execPath, [npmEntry], deps) ?? undefined,
    };
  }
  return { available: false };
}

/**
 * Codex adapter — spawns `codex exec [resume <sid>] --json ...` and parses the
 * JSONL event stream.
 *
 * Event shape (abridged):
 *   {"type":"thread.started","thread_id":"<uuid>"}
 *   {"type":"turn.started"}
 *   {"type":"item.started","item":{"type":"command_execution", ...}}
 *   {"type":"item.completed","item":{"type":"agent_message","text":"..."}}
 *   {"type":"turn.completed","usage":{...}}
 *
 * `codex exec` does not report USD cost — only token usage — so `costUsd` is
 * not populated from this adapter.
 *
 * ## systemContext injection: per-agent CODEX_HOME + AGENTS.md
 *
 * Codex has no `--append-system-prompt` equivalent. Its documented way to
 * inject instructions that do NOT land in the stored transcript is the
 * `AGENTS.md` loaded from `<CODEX_HOME>/AGENTS.md` (alongside the user-global
 * `~/.codex/AGENTS.md` and the cwd's `<cwd>/AGENTS.md`).
 *
 * This adapter therefore:
 *   1. Points `CODEX_HOME` at a per-agent directory:
 *      `~/.botcord/agents/<accountId>/codex-home/`
 *   2. Writes `opts.systemContext` to `<CODEX_HOME>/AGENTS.md` atomically
 *      (tmp + rename) before spawning the child.
 *   3. Leaves the positional prompt as just `opts.text` — no more prepending
 *      systemContext to the transcript.
 *
 * With the transcript no longer accumulating systemContext, resume is safe to
 * turn back on: `thread.started.thread_id` is persisted as `newSessionId`, and
 * when the next turn arrives with a sessionId the adapter runs `exec resume
 * <sid>` instead of `exec`. The per-agent CODEX_HOME also isolates codex's
 * `sessions/` directory from `~/.codex/sessions/`, so daemon-owned sessions
 * don't pollute the user's interactive session picker.
 *
 * ## `exec resume` flag quirk
 *
 * `codex exec resume` accepts a smaller flag set than `codex exec` — notably
 * `-s / --sandbox` is NOT accepted on `resume`. We therefore express sandbox
 * policy as `-c sandbox_mode="..."` (a `-c` override works on both
 * subcommands) and the same tail of flags applies to both paths.
 */
export class CodexAdapter extends NdjsonStreamAdapter {
  readonly id = "codex" as const;

  private readonly explicitBinary: string | undefined;
  private resolvedBinary: string | null = null;

  constructor(opts?: { binary?: string }) {
    super();
    this.explicitBinary = opts?.binary ?? process.env.BOTCORD_CODEX_BIN;
  }

  probe(): RuntimeProbeResult {
    return probeCodex();
  }

  /**
   * Validate the sessionId shape and materialize the per-agent CODEX_HOME +
   * AGENTS.md before handing off to the base adapter's spawn loop. Both steps
   * must run BEFORE `super.run()` because `spawnEnv()` and `buildArgs()` are
   * called synchronously from inside it and read the filesystem state we set
   * up here.
   */
  override async run(opts: RuntimeRunOptions) {
    if (opts.sessionId && !CODEX_SESSION_ID_RE.test(opts.sessionId)) {
      throw new Error(`codex: invalid sessionId "${opts.sessionId}" (expected UUID)`);
    }
    if (opts.accountId) {
      try {
        ensureAgentCodexHome(opts.accountId);
        writeCodexAgentsMd(opts.accountId, opts.systemContext);
      } catch (err) {
        // Writing AGENTS.md should never abort the turn — log and fall
        // through. The child will spawn without the dynamic systemContext,
        // which degrades to "codex replies without this turn's memory
        // snapshot" rather than silence.
        // eslint-disable-next-line no-console
        console.warn("codex: failed to prepare CODEX_HOME/AGENTS.md", err);
      }
    }
    return super.run(opts);
  }

  protected resolveBinary(): string {
    if (this.explicitBinary) return this.explicitBinary;
    if (this.resolvedBinary) return this.resolvedBinary;
    // Use the executable resolver only — probeCodex's npm-global fallback
    // yields a `.js` path that can't be spawned directly.
    this.resolvedBinary = resolveCodexCommand() ?? "codex";
    return this.resolvedBinary;
  }

  /**
   * `extraArgs` are passed as Codex CLI flags (inserted before `--`), not
   * prompt text. Use the route config's `extraArgs` for flags like
   * `-c model="..."`, not for extra prompt content.
   *
   * Layout for fresh session:  `exec   <tail> -- <prompt>`
   * Layout for resume:         `exec resume <sid> <tail> -- <prompt>`
   *
   * Both paths share the same `<tail>`: sandbox/approval policy (as `-c`
   * overrides so `resume` accepts them), `--skip-git-repo-check`, `--json`,
   * and operator `extraArgs`.
   */
  protected buildArgs(opts: RuntimeRunOptions): string[] {
    const tail: string[] = [];

    // Sandbox / approval policy. Expressed as `-c` overrides because
    // `codex exec resume` rejects `-s` / `--full-auto`. `-c` works on both
    // the fresh `exec` and `exec resume` paths.
    //
    // Daemon-driven Codex runs are non-interactive. Any mode that waits for a
    // local approval prompt can deadlock tool use because there is no prompt
    // relay back to the user yet. Default to bypassing both approvals and the
    // sandbox for every trust tier; operators who need a stricter posture can
    // still override with route/defaultRoute extraArgs.
    const hasSandboxOverride =
      opts.extraArgs?.some(
        (a) =>
          a === "-s" ||
          a.startsWith("--sandbox") ||
          a === "--full-auto" ||
          a === "--dangerously-bypass-approvals-and-sandbox" ||
          a.startsWith("-c sandbox_mode=") ||
          a.startsWith("-csandbox_mode="),
      ) ?? false;
    if (!hasSandboxOverride) {
      tail.push(
        "-c",
        'sandbox_mode="danger-full-access"',
        "-c",
        'approval_policy="never"',
      );
    }
    tail.push("--skip-git-repo-check", "--json");
    if (opts.extraArgs?.length) tail.push(...opts.extraArgs);

    // `--` separates flags from positionals so a prompt starting with `-`
    // can never be parsed as an option. `systemContext` is NOT prepended to
    // the prompt any more — it lives in `<CODEX_HOME>/AGENTS.md` written by
    // `run()` — so the transcript stays clean across resumes.
    const prompt = opts.text;
    if (opts.sessionId) {
      return ["exec", "resume", opts.sessionId, ...tail, "--", prompt];
    }
    return ["exec", ...tail, "--", prompt];
  }

  protected spawnEnv(opts: RuntimeRunOptions): NodeJS.ProcessEnv {
    const cliEnv = buildCliEnv({
      hubUrl: opts.hubUrl,
      accountId: opts.accountId,
      basePath: process.env.PATH,
    });
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...cliEnv,
      // Keep JSONL free of ANSI codes regardless of user terminal settings.
      FORCE_COLOR: "0",
      NO_COLOR: "1",
    };
    if (opts.accountId) {
      env.CODEX_HOME = agentCodexHomeDir(opts.accountId);
    }
    return env;
  }

  protected handleEvent(raw: unknown, ctx: NdjsonEventCtx): void {
    const obj = raw as {
      type?: string;
      thread_id?: string;
      item?: { type?: string; text?: string };
      error?: { message?: string } | string;
      turn?: { status?: string; error?: { message?: string } };
    };

    // Emit a thinking lifecycle hint BEFORE the block so the dispatcher's
    // auto-synthesis short-circuits (we provide a labeled event instead).
    // Conservative mapping per design doc §"Runtime adapter 映射".
    const status = codexStatusEvent(obj);
    if (status) ctx.emitStatus(status);

    ctx.emitBlock(normalizeBlock(obj, ctx.seq));

    // Persist the thread_id so the next turn on this session key resumes
    // instead of spawning fresh. Safe now that systemContext lives in
    // AGENTS.md rather than the transcript.
    if (obj.type === "thread.started") {
      if (typeof obj.thread_id === "string") {
        ctx.state.newSessionId = obj.thread_id;
      }
      return;
    }

    if (obj.type === "item.completed" && obj.item?.type === "agent_message") {
      if (typeof obj.item.text === "string") {
        ctx.appendAssistantText(obj.item.text);
        // The last agent_message is the final reply.
        ctx.state.finalText = obj.item.text;
      }
      return;
    }

    if (obj.type === "turn.completed" && obj.turn?.status === "failed") {
      const msg = obj.turn.error?.message;
      if (typeof msg === "string" && msg) ctx.state.errorText = msg;
      return;
    }

    if (obj.type === "error") {
      ctx.state.errorText =
        typeof obj.error === "string"
          ? obj.error
          : obj.error?.message ?? "codex error";
    }
  }
}

/**
 * Map a Codex JSONL event to a `RuntimeStatusEvent` for the dispatcher's
 * thinking UI. Returns `undefined` for events that should not influence
 * status (the dispatcher already synthesizes a generic marker on the first
 * non-assistant block, so we only override when a label is meaningful).
 */
function codexStatusEvent(obj: {
  type?: string;
  item?: { type?: string };
  turn?: { status?: string };
}): import("../types.js").RuntimeStatusEvent | undefined {
  if (obj.type === "thread.started") {
    return { kind: "thinking", phase: "started", label: "Starting session" };
  }
  if (obj.type === "turn.started") {
    return { kind: "thinking", phase: "started", label: "Thinking" };
  }
  if (obj.type === "item.started" && typeof obj.item?.type === "string") {
    const tool = obj.item.type;
    if (
      tool === "command_execution" ||
      tool === "file_change" ||
      tool === "mcp_tool_call" ||
      tool === "web_search"
    ) {
      return { kind: "thinking", phase: "updated", label: codexToolLabel(tool) };
    }
  }
  if (obj.type === "item.completed" && obj.item?.type === "agent_message") {
    return { kind: "thinking", phase: "stopped" };
  }
  if (obj.type === "turn.completed") {
    return { kind: "thinking", phase: "stopped" };
  }
  return undefined;
}

function codexToolLabel(tool: string): string {
  switch (tool) {
    case "command_execution":
      return "Running command";
    case "file_change":
      return "Editing files";
    case "mcp_tool_call":
      return "Calling tool";
    case "web_search":
      return "Searching web";
    default:
      return tool;
  }
}

/**
 * Atomically overwrite `<CODEX_HOME>/AGENTS.md` with `systemContext`. codex
 * reads this file at process start, so the write must complete before spawn.
 * An empty or missing systemContext writes an empty file — deleting would
 * race with a prior turn's file still being readable; empty is simpler and
 * codex treats it as "no user-global AGENTS.md".
 */
function writeCodexAgentsMd(accountId: string, systemContext: string | undefined): void {
  const dir = agentCodexHomeDir(accountId);
  // ensureAgentCodexHome already mkdir's dir; defensive mkdir here too for
  // code paths that invoke this helper directly (tests, future callers).
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const target = path.join(dir, "AGENTS.md");
  const tmp = path.join(dir, `.AGENTS.md.${process.pid}.tmp`);
  writeFileSync(tmp, systemContext ?? "", { mode: 0o600 });
  renameSync(tmp, target);
}

function normalizeBlock(obj: any, seq: number): StreamBlock {
  let kind: StreamBlock["kind"] = "other";
  const type: string | undefined = obj?.type;
  const itemType: string | undefined = obj?.item?.type;

  if (type === "thread.started" || type === "turn.started" || type === "turn.completed") {
    kind = "system";
  } else if (type === "item.completed" && itemType === "agent_message") {
    kind = "assistant_text";
  } else if (type === "item.started" || type === "item.completed") {
    if (
      itemType === "command_execution" ||
      itemType === "file_change" ||
      itemType === "mcp_tool_call" ||
      itemType === "web_search"
    ) {
      kind = "tool_use";
    }
  }
  return { raw: obj, kind, seq };
}
