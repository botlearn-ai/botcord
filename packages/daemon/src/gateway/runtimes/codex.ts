import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
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
 * Codex adapter — spawns `codex exec --json ...` and parses the JSONL event stream.
 *
 * Event shape (abridged):
 *   {"type":"thread.started","thread_id":"<uuid>"}
 *   {"type":"turn.started"}
 *   {"type":"item.started","item":{"type":"command_execution", ...}}
 *   {"type":"item.completed","item":{"type":"agent_message","text":"..."}}
 *   {"type":"turn.completed","usage":{...}}
 *
 * Codex exec does not report USD cost — only token usage — so costUsd is not
 * populated from this adapter.
 *
 * ## Session-resume policy (方案 A): every turn is a fresh session.
 *
 * Codex has no `--append-system-prompt` equivalent: anything we put in the
 * positional prompt becomes part of the stored transcript. If we called
 * `exec resume <sid> "<systemContext>\n<text>"` each turn, the prior turn's
 * systemContext would already be in the transcript AND we'd prepend a new
 * copy — memory/digest would duplicate every turn, and stale cross-room
 * state would pile up indefinitely.
 *
 * Workaround: always spawn a fresh session. `opts.sessionId` is read to
 * validate (reject malformed UUIDs early, as a defense-in-depth holdover)
 * but not used as argv; `thread.started` events no longer populate
 * `state.newSessionId`, so the dispatcher's SessionStore stays empty for
 * Codex routes and no resume is attempted next turn.
 *
 * Continuity across turns therefore comes from the injected systemContext
 * (working memory + cross-room digest) rather than from Codex's own
 * transcript. A future adapter could opt back into resume by re-enabling
 * the thread_id propagation, but must first solve the accumulation problem.
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
   * Strip `sessionId` on the way into the base adapter's run loop so the
   * initial `state.newSessionId` seed is empty. Combined with the no-op
   * `thread.started` handler, this guarantees the dispatcher receives an
   * empty `newSessionId` and never writes Codex entries to SessionStore.
   *
   * The UUID validation still runs as defense-in-depth: even though the
   * id is never forwarded to argv, rejecting malformed input early catches
   * callers who accidentally shove non-UUID state through this field.
   */
  override async run(opts: RuntimeRunOptions) {
    if (opts.sessionId && !CODEX_SESSION_ID_RE.test(opts.sessionId)) {
      throw new Error(`codex: invalid sessionId "${opts.sessionId}" (expected UUID)`);
    }
    return super.run({ ...opts, sessionId: null });
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
   * `-s workspace-write`, not for extra prompt content.
   */
  protected buildArgs(opts: RuntimeRunOptions): string[] {
    const tail: string[] = [];
    // Sandbox / approval policy:
    //  - owner turn: bypass approvals + sandbox (preserves the old default; owner trusts their agent).
    //  - non-owner turn: no bypass, default to `-s workspace-write` so edits are at least scoped.
    // Operators can override either via extraArgs (`-s read-only`, `--full-auto`, etc.).
    const hasSandbox =
      opts.extraArgs?.some(
        (a) => a === "-s" || a.startsWith("--sandbox") || a === "--full-auto",
      ) ?? false;
    const hasBypass =
      opts.extraArgs?.includes("--dangerously-bypass-approvals-and-sandbox") ?? false;
    if (!hasSandbox && !hasBypass) {
      if (opts.trustLevel === "owner") {
        tail.push("--dangerously-bypass-approvals-and-sandbox");
      } else {
        tail.push("-s", "workspace-write");
      }
    }
    tail.push("--skip-git-repo-check", "--json");
    if (opts.extraArgs?.length) tail.push(...opts.extraArgs);

    // `--` separates flags from positionals so a prompt starting with `-`
    // can never be parsed as an option. Operator-supplied `extraArgs` appear
    // before `--` and are interpreted as CLI flags. `opts.sessionId` has
    // already been validated + stripped in `run()`, so `exec resume` is
    // never emitted.
    const prompt = opts.systemContext
      ? `${opts.systemContext}\n\n---\n\n${opts.text}`
      : opts.text;
    return ["exec", ...tail, "--", prompt];
  }

  protected spawnEnv(_opts: RuntimeRunOptions): NodeJS.ProcessEnv {
    // Keep JSONL free of ANSI codes regardless of user terminal settings.
    return { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" };
  }

  protected handleEvent(raw: unknown, ctx: NdjsonEventCtx): void {
    const obj = raw as {
      type?: string;
      thread_id?: string;
      item?: { type?: string; text?: string };
      error?: { message?: string } | string;
      turn?: { status?: string; error?: { message?: string } };
    };

    ctx.emitBlock(normalizeBlock(obj, ctx.seq));

    // `thread.started` is emitted but intentionally not stored: resume is
    // disabled (see class doc). The dispatcher reads `state.newSessionId` to
    // decide whether to persist into SessionStore; leaving it empty keeps
    // Codex routes stateless across turns.
    if (obj.type === "thread.started") {
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
