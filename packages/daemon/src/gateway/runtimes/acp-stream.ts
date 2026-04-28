import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
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
 * Minimal bidirectional ACP (Agent Client Protocol) client used by runtime
 * adapters whose backing CLI speaks ACP over stdio (JSON-RPC 2.0,
 * newline-delimited).
 *
 * Why a base class instead of `NdjsonStreamAdapter`: ACP is a bidirectional
 * RPC protocol — the agent sends notifications (`session/update`) AND
 * server-initiated requests (`session/request_permission`) that the daemon
 * MUST reply to or the agent stalls. The ndjson base only models a one-way
 * event stream, so it cannot drive ACP correctly.
 */

const log = consoleLogger;

/** How much stderr we keep for error reporting. */
const STDERR_TAIL_CAP = 8 * 1024;
/** How much of the retained stderr is included in synthesized errors. */
const STDERR_ERROR_SNIPPET = 500;
/** Cap on streamed assistant text per turn — guards a runaway runtime. */
const ASSISTANT_TEXT_CAP = 1 * 1024 * 1024;
/** Grace period between SIGTERM and SIGKILL on abort. */
const KILL_GRACE_MS = 5_000;
/** Deadline for the initial `initialize` handshake. */
const INITIALIZE_TIMEOUT_MS = 30_000;
/** ACP protocol version this client targets. */
export const ACP_PROTOCOL_VERSION = 1;

export interface AcpInitializeResult {
  protocolVersion?: number;
  agentInfo?: { name?: string; version?: string };
  agentCapabilities?: Record<string, unknown>;
  authMethods?: Array<{ id?: string; name?: string; description?: string }>;
  [k: string]: unknown;
}

export interface AcpPermissionOption {
  optionId: string;
  name?: string;
  /**
   * ACP option kind. Common values: `allow_once`, `allow_always`,
   * `reject_once`, `reject_always`. Treated as opaque by the base class —
   * subclasses inspect `.kind` to pick the right outcome.
   */
  kind?: string;
  [k: string]: unknown;
}

export interface AcpPermissionRequest {
  sessionId: string;
  toolCall?: { name?: string; rawInput?: unknown; [k: string]: unknown };
  options: AcpPermissionOption[];
  [k: string]: unknown;
}

export type AcpPermissionResponse =
  | { outcome: { outcome: "selected"; optionId: string } }
  | { outcome: { outcome: "cancelled" } };

export interface AcpUpdateParams {
  sessionId: string;
  update: { sessionUpdate?: string; [k: string]: unknown };
  [k: string]: unknown;
}

/** Hooks exposed to subclasses to react to inbound traffic during a turn. */
export interface AcpTurnHooks {
  /** Called for each `session/update` notification. */
  onUpdate(params: AcpUpdateParams, ctx: AcpUpdateCtx): void;
  /** Called for `session/request_permission` requests. Must resolve to an outcome. */
  onPermissionRequest(req: AcpPermissionRequest): Promise<AcpPermissionResponse>;
}

export interface AcpUpdateCtx {
  /** Append to the turn's running assistant text. */
  appendAssistantText(text: string): void;
  /** Forward a normalized StreamBlock to `opts.onBlock`. */
  emitBlock(block: StreamBlock): void;
  /**
   * Forward a runtime status event (typing / thinking) to the dispatcher.
   * Useful for ACP `session/update` shapes that signal "agent is busy" but
   * carry no displayable content (e.g. thought chunks, tool progress).
   */
  emitStatus(event: RuntimeStatusEvent): void;
  /** 1-based sequence within this turn. */
  seq: number;
}

interface PendingCall {
  resolve(value: unknown): void;
  reject(err: Error): void;
}

/** Minimal newline-JSON-RPC framing on top of a child process's stdio. */
class AcpConnection {
  private nextId = 1;
  private readonly pending = new Map<number, PendingCall>();
  private stdoutBuf = "";
  private closed = false;
  private closeReason: Error | null = null;

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly handlers: {
      onNotification(method: string, params: unknown): void;
      onRequest(
        method: string,
        params: unknown,
      ): Promise<unknown> | unknown;
    },
    private readonly logId: string,
  ) {
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.onStdout(chunk));
    child.stdout.on("end", () => this.fail(new Error("stdout closed")));
    child.on("close", (code) =>
      this.fail(new Error(`process exited with code ${code ?? 0}`)),
    );
    child.on("error", (err) => this.fail(err));
  }

  private onStdout(chunk: string): void {
    this.stdoutBuf += chunk;
    let idx: number;
    while ((idx = this.stdoutBuf.indexOf("\n")) !== -1) {
      const line = this.stdoutBuf.slice(0, idx).trim();
      this.stdoutBuf = this.stdoutBuf.slice(idx + 1);
      if (!line) continue;
      this.dispatchLine(line);
    }
  }

  private dispatchLine(line: string): void {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      log.warn(`${this.logId} non-json acp line`, { line: line.slice(0, 200) });
      return;
    }
    if (typeof msg !== "object" || msg === null) return;
    // Response to a client→server request
    if (typeof msg.id === "number" && (msg.result !== undefined || msg.error !== undefined)) {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      if (msg.error) {
        const err = new Error(
          `acp error ${msg.error.code ?? "?"}: ${msg.error.message ?? "(no message)"}`,
        );
        pending.reject(err);
      } else {
        pending.resolve(msg.result ?? null);
      }
      return;
    }
    if (typeof msg.method === "string") {
      // Server→client request (has `id`) or notification (no `id`)
      if (msg.id !== undefined) {
        void this.handleServerRequest(msg.id, msg.method, msg.params);
      } else {
        try {
          this.handlers.onNotification(msg.method, msg.params);
        } catch (err) {
          log.warn(`${this.logId} notification handler threw`, {
            method: msg.method,
            err: String(err),
          });
        }
      }
    }
  }

  private async handleServerRequest(
    id: number | string,
    method: string,
    params: unknown,
  ): Promise<void> {
    let result: unknown;
    let error: { code: number; message: string } | null = null;
    try {
      result = await this.handlers.onRequest(method, params);
    } catch (err) {
      error = {
        code: -32603,
        message: err instanceof Error ? err.message : String(err),
      };
    }
    const reply = error
      ? { jsonrpc: "2.0", id, error }
      : { jsonrpc: "2.0", id, result: result ?? null };
    this.writeMessage(reply);
  }

  private writeMessage(obj: unknown): void {
    if (this.closed) return;
    try {
      this.child.stdin.write(JSON.stringify(obj) + "\n");
    } catch (err) {
      this.fail(err instanceof Error ? err : new Error(String(err)));
    }
  }

  request<T = unknown>(method: string, params: unknown): Promise<T> {
    if (this.closed) {
      return Promise.reject(this.closeReason ?? new Error("acp closed"));
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (v) => resolve(v as T),
        reject,
      });
      this.writeMessage({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    this.writeMessage({ jsonrpc: "2.0", method, params });
  }

  private fail(err: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.closeReason = err;
    for (const [, p] of this.pending) p.reject(err);
    this.pending.clear();
  }

  isClosed(): boolean {
    return this.closed;
  }
}

/** Subclass-supplied per-turn run state, mostly here so subclasses can
 *  customize how `onUpdate` mutates the running assistant text. */
interface AcpRunState {
  finalText: string;
  assistantTextChunks: string[];
  assistantTextBytes: number;
  assistantTextCapped: boolean;
  errorText?: string;
}

export abstract class AcpRuntimeAdapter implements RuntimeAdapter {
  abstract readonly id: string;

  probe?(): RuntimeProbeResult;

  protected abstract resolveBinary(opts: RuntimeRunOptions): string;
  /** Argv tail (excluding the binary). ACP servers usually take none. */
  protected buildArgs(_opts: RuntimeRunOptions): string[] {
    return [];
  }
  protected abstract spawnEnv(opts: RuntimeRunOptions): NodeJS.ProcessEnv;
  /** Subclass hook: react to one `session/update` notification. */
  protected abstract onUpdate(params: AcpUpdateParams, ctx: AcpUpdateCtx): void;
  /** Subclass hook: respond to a `session/request_permission` request. */
  protected abstract onPermissionRequest(
    req: AcpPermissionRequest,
    opts: RuntimeRunOptions,
  ): Promise<AcpPermissionResponse>;

  /** Runtime-specific clientCapabilities sent on initialize. */
  protected clientCapabilities(): Record<string, unknown> {
    return { fs: { readTextFile: false, writeTextFile: false } };
  }

  /** Runtime-specific clientInfo sent on initialize. */
  protected clientInfo(): { name: string; version: string } {
    return { name: "botcord-daemon", version: "0.1" };
  }

  /**
   * Hook invoked synchronously before spawn. Subclasses use this to write
   * systemContext to disk (e.g. `<cwd>/AGENTS.md`).
   */
  protected prepareTurn(_opts: RuntimeRunOptions): void {
    /* default: noop */
  }

  /** cwd passed to ACP `session/new` / `session/load`. Typically `opts.cwd`. */
  protected sessionCwd(opts: RuntimeRunOptions): string {
    return opts.cwd;
  }

  async run(opts: RuntimeRunOptions): Promise<RuntimeRunResult> {
    if (opts.signal.aborted) {
      return {
        text: "",
        newSessionId: opts.sessionId ?? "",
        error: `${this.id} aborted before spawn`,
      };
    }

    try {
      this.prepareTurn(opts);
    } catch (err) {
      log.warn(`${this.id} prepareTurn threw`, { err: String(err) });
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
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;

    let killTimer: ReturnType<typeof setTimeout> | null = null;
    const onAbort = () => {
      if (child.killed) return;
      try {
        child.stdin.end();
      } catch {
        /* best-effort */
      }
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        if (!child.killed) {
          log.warn(`${this.id} did not exit after SIGTERM; sending SIGKILL`);
          try {
            child.kill("SIGKILL");
          } catch {
            /* best-effort */
          }
        }
      }, KILL_GRACE_MS);
      if (typeof killTimer.unref === "function") killTimer.unref();
    };
    opts.signal.addEventListener("abort", onAbort, { once: true });

    let stderrTail = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_CAP);
    });

    const state: AcpRunState = {
      finalText: "",
      assistantTextChunks: [],
      assistantTextBytes: 0,
      assistantTextCapped: false,
    };

    const appendAssistantText = (text: string): void => {
      if (!text || state.assistantTextCapped) return;
      const budget = ASSISTANT_TEXT_CAP - state.assistantTextBytes;
      if (budget <= 0) {
        state.assistantTextCapped = true;
        return;
      }
      if (text.length > budget) {
        state.assistantTextChunks.push(text.slice(0, budget));
        state.assistantTextBytes += budget;
        state.assistantTextCapped = true;
        return;
      }
      state.assistantTextChunks.push(text);
      state.assistantTextBytes += text.length;
    };

    let seq = 0;

    const conn = new AcpConnection(
      child,
      {
        onNotification: (method, params) => {
          if (method === "session/update") {
            seq += 1;
            this.onUpdate(params as AcpUpdateParams, {
              appendAssistantText,
              emitBlock: (b) => opts.onBlock?.(b),
              emitStatus: (e) => {
                try {
                  opts.onStatus?.(e);
                } catch (err) {
                  log.warn(`${this.id} onStatus threw`, { err: String(err) });
                }
              },
              seq,
            });
          }
        },
        onRequest: async (method, params) => {
          if (method === "session/request_permission") {
            return this.onPermissionRequest(
              params as AcpPermissionRequest,
              opts,
            );
          }
          // Unknown server→client request: signal "method not found" so the
          // server can decide what to do. Throwing here surfaces as a JSON-RPC
          // error reply via AcpConnection.
          const err = new Error(`unknown server request: ${method}`);
          throw err;
        },
      },
      this.id,
    );

    const childExit = new Promise<number>((resolve) => {
      child.on("close", (code) => resolve(code ?? 0));
    });

    let newSessionId = opts.sessionId ?? "";

    try {
      // 1) initialize
      await this.withTimeout(
        conn.request<AcpInitializeResult>("initialize", {
          protocolVersion: ACP_PROTOCOL_VERSION,
          clientCapabilities: this.clientCapabilities(),
          clientInfo: this.clientInfo(),
        }),
        INITIALIZE_TIMEOUT_MS,
        "initialize",
      );

      // 2) session/load (if resuming) → fallback to session/new
      const cwd = this.sessionCwd(opts);
      let sessionId = "";
      if (opts.sessionId) {
        try {
          const loaded = (await conn.request<unknown>("session/load", {
            sessionId: opts.sessionId,
            cwd,
            mcpServers: [],
          })) as { sessionId?: string } | null;
          if (loaded !== null && loaded !== undefined) {
            // Hermes' load_session does NOT return a session_id — reuse the
            // requested one. If a future server returns one, prefer it.
            sessionId =
              (loaded && typeof loaded.sessionId === "string"
                ? loaded.sessionId
                : "") || opts.sessionId;
          }
        } catch (err) {
          log.warn(`${this.id} session/load failed; falling back to new`, {
            err: err instanceof Error ? err.message : String(err),
          });
        }
      }
      if (!sessionId) {
        const created = await conn.request<{ sessionId?: string }>(
          "session/new",
          { cwd, mcpServers: [] },
        );
        sessionId = created?.sessionId ?? "";
      }
      if (!sessionId) {
        throw new Error("acp server did not return a sessionId");
      }
      newSessionId = sessionId;

      // 3) session/prompt
      const promptResult = (await conn.request<unknown>("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: opts.text }],
      })) as { stopReason?: string } | null;

      const stopReason = promptResult?.stopReason ?? "end_turn";
      if (stopReason === "refusal" || stopReason === "error") {
        state.errorText = state.errorText ?? `prompt stopped: ${stopReason}`;
      }
      // Tell the dispatcher the runtime has finished its reasoning loop —
      // important for turns that ended without an `agent_message_chunk`
      // (tool-only side effect, refusal, error). The dispatcher's finally
      // block also emits a final thinking.stopped, but firing here delivers
      // it on the wire before child exit (which can take seconds).
      try {
        opts.onStatus?.({ kind: "thinking", phase: "stopped" });
      } catch (err) {
        log.warn(`${this.id} onStatus(prompt-done) threw`, { err: String(err) });
      }

      // Politely close stdin so the server can exit. Some ACP servers shut
      // down on EOF; if not, abort signal will SIGTERM.
      try {
        child.stdin.end();
      } catch {
        /* best-effort */
      }
    } catch (err) {
      state.errorText =
        state.errorText ??
        (err instanceof Error ? err.message : String(err));
      try {
        child.stdin.end();
      } catch {
        /* best-effort */
      }
    }

    let code = 0;
    try {
      code = await childExit;
    } finally {
      opts.signal.removeEventListener("abort", onAbort);
      if (killTimer) clearTimeout(killTimer);
    }

    if (code !== 0 && !state.errorText) {
      state.errorText = `${this.id} exited with code ${code}: ${stderrTail.slice(
        -STDERR_ERROR_SNIPPET,
      )}`;
    }

    const rawText =
      state.finalText || state.assistantTextChunks.join("").trim();
    const text =
      rawText.length > ASSISTANT_TEXT_CAP
        ? rawText.slice(0, ASSISTANT_TEXT_CAP)
        : rawText;

    return {
      text,
      newSessionId,
      ...(state.errorText ? { error: state.errorText } : {}),
    };
  }

  private withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const t = setTimeout(
        () => reject(new Error(`${this.id} ${label} timed out after ${ms}ms`)),
        ms,
      );
      if (typeof t.unref === "function") t.unref();
      p.then(
        (v) => {
          clearTimeout(t);
          resolve(v);
        },
        (e) => {
          clearTimeout(t);
          reject(e);
        },
      );
    });
  }
}
