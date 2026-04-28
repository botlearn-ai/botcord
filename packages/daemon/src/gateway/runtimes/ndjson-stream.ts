import { spawn } from "node:child_process";
import { buildCliEnv } from "../cli-resolver.js";
import { consoleLogger } from "../log.js";
import type {
  RuntimeAdapter,
  RuntimeProbeResult,
  RuntimeRunOptions,
  RuntimeRunResult,
  RuntimeStatusEvent,
  StreamBlock,
} from "../types.js";

/**
 * Mutable state threaded through event callbacks while a single turn runs.
 * The base class reads these fields to assemble the final RuntimeRunResult.
 */
export interface NdjsonRunState {
  /** Session id to persist for `--resume`. Seeded with the incoming sessionId. */
  newSessionId: string;
  /** Final text reported by a terminal "result"/"completed" event, if any. */
  finalText: string;
  /** Streamed assistant text chunks; concatenated as a fallback when finalText is empty. */
  assistantTextChunks: string[];
  /** Running byte total of everything pushed to assistantTextChunks. */
  assistantTextBytes: number;
  /** True once the per-turn text cap was hit; further chunks are dropped. */
  assistantTextCapped: boolean;
  costUsd?: number;
  errorText?: string;
}

/** Per-event context handed to subclasses from the ndjson dispatch loop. */
export interface NdjsonEventCtx {
  state: NdjsonRunState;
  /** 1-based sequence within this turn, identical to what `onBlock` would see. */
  seq: number;
  /** Forward a normalized StreamBlock to the caller's onBlock handler. */
  emitBlock: (block: StreamBlock) => void;
  /**
   * Push streamed assistant text while respecting the per-turn byte cap.
   * Subclasses should use this instead of `state.assistantTextChunks.push(...)`.
   */
  appendAssistantText: (text: string) => void;
  /**
   * Forward a runtime status event (typing / thinking) to the dispatcher.
   * Adapters should call this when an event reveals the runtime's lifecycle
   * stage before any visible block lands — e.g. Codex `thread.started`,
   * Claude Code `system` init. Errors thrown here are swallowed.
   */
  emitStatus: (event: RuntimeStatusEvent) => void;
}

const log = consoleLogger;

/**
 * Common scaffold for CLI adapters that emit newline-delimited JSON on stdout.
 * Subclasses plug in:
 *   - resolveBinary() — which executable to spawn
 *   - buildArgs()     — argv tail (excluding the binary itself)
 *   - handleEvent()   — how to interpret one parsed JSON object
 *
 * The base class handles spawn, abort wiring, stderr capping, line splitting,
 * and exit-code error synthesis so every new runtime only writes the parts
 * that are actually runtime-specific.
 */
/** How much stderr is retained for error reporting. */
const STDERR_TAIL_CAP = 8 * 1024;
/** How much of the retained stderr is included in the synthesized exit-code error. */
const STDERR_ERROR_SNIPPET = 500;
/** Cap on total streamed assistant text bytes per turn — guards against a runaway CLI. */
const ASSISTANT_TEXT_CAP = 1 * 1024 * 1024;
/** Grace period between SIGTERM and SIGKILL when an abort is requested. */
const KILL_GRACE_MS = 5_000;

/** Base class for runtime adapters that drive a CLI emitting newline-delimited JSON. */
export abstract class NdjsonStreamAdapter implements RuntimeAdapter {
  abstract readonly id: string;

  probe?(): RuntimeProbeResult;

  protected abstract resolveBinary(opts: RuntimeRunOptions): string;
  protected abstract buildArgs(opts: RuntimeRunOptions): string[];
  protected abstract handleEvent(obj: unknown, ctx: NdjsonEventCtx): void;

  /**
   * Override to tweak env (FORCE_COLOR=0, NO_COLOR=1, etc). Subclasses that
   * override should compose with the bundled-CLI env helper so spawned
   * `botcord` invocations stay scoped to the right hub/agent — see
   * {@link buildCliEnv}.
   */
  protected spawnEnv(opts: RuntimeRunOptions): NodeJS.ProcessEnv {
    return {
      ...process.env,
      ...buildCliEnv({
        hubUrl: opts.hubUrl,
        accountId: opts.accountId,
        basePath: process.env.PATH,
      }),
    };
  }

  async run(opts: RuntimeRunOptions): Promise<RuntimeRunResult> {
    if (opts.signal.aborted) {
      return {
        text: "",
        newSessionId: opts.sessionId ?? "",
        error: `${this.id} aborted before spawn`,
      };
    }

    const binary = this.resolveBinary(opts);
    const args = this.buildArgs(opts);

    log.debug(`${this.id} spawn`, {
      cwd: opts.cwd,
      sessionId: opts.sessionId,
      argv: args,
    });

    const child = spawn(binary, args, {
      cwd: opts.cwd,
      env: this.spawnEnv(opts),
      stdio: ["ignore", "pipe", "pipe"],
    });

    // Attach abort listener immediately — spawn is synchronous, but a racing
    // `.abort()` between `spawn` and a listener added later would be lost.
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    const onAbort = () => {
      if (child.killed) return;
      child.kill("SIGTERM");
      // Escalate to SIGKILL if the child ignores the polite request.
      killTimer = setTimeout(() => {
        if (!child.killed) {
          log.warn(`${this.id} did not exit after SIGTERM; sending SIGKILL`);
          try {
            child.kill("SIGKILL");
          } catch {
            // best-effort
          }
        }
      }, KILL_GRACE_MS);
      if (typeof killTimer.unref === "function") killTimer.unref();
    };
    opts.signal.addEventListener("abort", onAbort, { once: true });

    const state: NdjsonRunState = {
      newSessionId: opts.sessionId ?? "",
      finalText: "",
      assistantTextChunks: [],
      assistantTextBytes: 0,
      assistantTextCapped: false,
    };

    const appendAssistantText = (text: string): void => {
      if (!text) return;
      if (state.assistantTextCapped) return;
      const budget = ASSISTANT_TEXT_CAP - state.assistantTextBytes;
      if (budget <= 0) {
        state.assistantTextCapped = true;
        log.warn(`${this.id} assistant text exceeded ${ASSISTANT_TEXT_CAP} bytes; dropping further chunks`);
        return;
      }
      if (text.length > budget) {
        state.assistantTextChunks.push(text.slice(0, budget));
        state.assistantTextBytes += budget;
        state.assistantTextCapped = true;
        log.warn(`${this.id} assistant text hit ${ASSISTANT_TEXT_CAP}-byte cap`);
        return;
      }
      state.assistantTextChunks.push(text);
      state.assistantTextBytes += text.length;
    };

    let stderrTail = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_CAP);
    });

    let seq = 0;
    let stdoutBuf = "";
    child.stdout!.setEncoding("utf8");
    const dispatchLine = (line: string) => {
      if (!line) return;
      let obj: unknown;
      try {
        obj = JSON.parse(line);
      } catch {
        log.warn(`${this.id} non-json stdout line`, { line: line.slice(0, 200) });
        return;
      }
      seq += 1;
      try {
        this.handleEvent(obj, {
          state,
          seq,
          emitBlock: (b) => opts.onBlock?.(b),
          appendAssistantText,
          emitStatus: (e) => {
            try {
              opts.onStatus?.(e);
            } catch (err) {
              log.warn(`${this.id} onStatus threw`, { err: String(err) });
            }
          },
        });
      } catch (err) {
        log.warn(`${this.id} event handler threw`, { err: String(err) });
      }
    };

    child.stdout!.on("data", (chunk: string) => {
      stdoutBuf += chunk;
      let idx: number;
      while ((idx = stdoutBuf.indexOf("\n")) !== -1) {
        const line = stdoutBuf.slice(0, idx).trim();
        stdoutBuf = stdoutBuf.slice(idx + 1);
        dispatchLine(line);
      }
    });

    let code = 0;
    try {
      code = await new Promise<number>((resolve, reject) => {
        child.on("error", reject);
        child.on("close", (c) => resolve(c ?? 0));
      });
    } finally {
      opts.signal.removeEventListener("abort", onAbort);
      if (killTimer) clearTimeout(killTimer);
    }

    // Flush any final line that lacked a terminating newline.
    const residual = stdoutBuf.trim();
    if (residual) dispatchLine(residual);

    if (code !== 0 && !state.errorText) {
      state.errorText = `${this.id} exited with code ${code}: ${stderrTail.slice(-STDERR_ERROR_SNIPPET)}`;
    }

    const rawText = state.finalText || state.assistantTextChunks.join("").trim();
    const text =
      rawText.length > ASSISTANT_TEXT_CAP ? rawText.slice(0, ASSISTANT_TEXT_CAP) : rawText;

    return {
      text,
      newSessionId: state.newSessionId,
      ...(state.costUsd !== undefined ? { costUsd: state.costUsd } : {}),
      ...(state.errorText ? { error: state.errorText } : {}),
    };
  }
}
