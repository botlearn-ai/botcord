import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createAcpTraceLogger, type AcpTraceLogger } from "../../acp-logs.js";
import { consoleLogger } from "../log.js";
import { sliceUtf8Bytes, utf8ByteLength } from "./text-cap.js";
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
/** Short drain window for late `session/update` chunks after a prompt RPC error. */
const PROMPT_ERROR_DRAIN_MS = 750;
/**
 * No-output watchdog: if the ACP child produces zero stdout/stderr traffic for
 * this long while a turn is in flight, treat it as hung and kill it. ACP agents
 * stream `session/update` frames (tool calls, thought chunks, message chunks)
 * frequently, so a long silence is a genuine hang (e.g. hermes raising an
 * internal error that never returns an RPC reply) rather than slow-but-alive
 * work. Without this, a stuck turn sits dead until the dispatcher's 30-min
 * outer turn timeout. The default is intentionally generous to never cut off a
 * legitimately long tool call; override per deployment, 0 disables.
 */
const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60 * 1000;

function acpIdleTimeoutMs(): number {
  const raw = process.env.BOTCORD_ACP_IDLE_TIMEOUT_MS;
  if (raw === undefined || raw === "") return DEFAULT_IDLE_TIMEOUT_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_IDLE_TIMEOUT_MS;
}

/** ACP protocol version this client targets. */
export const ACP_PROTOCOL_VERSION = 1;

function stringField(obj: unknown, key: string): string | undefined {
  if (!obj || typeof obj !== "object") return undefined;
  const value = (obj as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

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
    private readonly trace: AcpTraceLogger | null = null,
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
      this.trace?.write({ stream: "stdout_non_json", chunk: line });
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
        this.trace?.write({
          stream: "rpc_in",
          direction: "in",
          id: msg.id,
          status: "error",
          code: typeof msg.error.code === "number" ? msg.error.code : undefined,
          error: msg.error.message ?? "(no message)",
        });
        const err = new Error(`acp error ${msg.error.code ?? "?"}: ${formatRpcError(msg.error)}`);
        pending.reject(err);
      } else {
        this.trace?.write({
          stream: "rpc_in",
          direction: "in",
          id: msg.id,
          status: "response",
          result: msg.result ?? null,
        });
        pending.resolve(msg.result ?? null);
      }
      return;
    }
    if (typeof msg.method === "string") {
      // Server→client request (has `id`) or notification (no `id`)
      if (msg.id !== undefined) {
        this.trace?.write({
          stream: "rpc_in",
          direction: "in",
          id: msg.id,
          method: msg.method,
          status: "request",
          params: msg.params,
        });
        void this.handleServerRequest(msg.id, msg.method, msg.params);
      } else {
        this.trace?.write({
          stream: "rpc_in",
          direction: "in",
          method: msg.method,
          status: "notification",
          params: msg.params,
        });
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
    this.trace?.write({
      stream: "rpc_out",
      direction: "out",
      id,
      status: error ? "error" : "response",
      code: error?.code,
      error: error?.message,
      result: error ? undefined : result ?? null,
    });
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
      this.trace?.write({
        stream: "rpc_out",
        direction: "out",
        id,
        method,
        status: "request",
        params,
      });
      this.writeMessage({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    this.trace?.write({
      stream: "rpc_out",
      direction: "out",
      method,
      status: "notification",
      params,
    });
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
    const trace = createAcpTraceLogger({
      runtime: this.id,
      accountId: opts.accountId,
      turnId: stringField(opts.context, "turnId"),
      roomId: stringField(opts.context, "roomId"),
      topicId: stringField(opts.context, "topicId") ?? null,
      hermesProfile: opts.hermesProfile,
      sessionId: opts.sessionId,
    });
    trace?.write({
      stream: "child_start",
      pid: child.pid,
      params: { command: binary, args, cwd: opts.cwd },
    });

    let killTimer: ReturnType<typeof setTimeout> | null = null;
    const forceKill = () => {
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
    const onAbort = () => forceKill();
    opts.signal.addEventListener("abort", onAbort, { once: true });

    const state: AcpRunState = {
      finalText: "",
      assistantTextChunks: [],
      assistantTextBytes: 0,
      assistantTextCapped: false,
    };

    // No-output watchdog. `armIdle` is (re)called on every stdout/stderr chunk,
    // so the timer only fires after a full window of silence. A hung ACP child
    // (e.g. an internal error that never produces an RPC reply or a final
    // `session/update`) is then killed here, surfacing as an error instead of
    // sitting dead until the dispatcher's 30-min outer turn timeout. We stamp
    // `errorText` BEFORE killing so it wins over the "stdout closed" rejection
    // the kill triggers on the in-flight prompt RPC.
    const idleMs = acpIdleTimeoutMs();
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    const clearIdle = () => {
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
    };
    const armIdle = () => {
      if (idleMs <= 0 || child.killed) return;
      clearIdle();
      idleTimer = setTimeout(() => {
        if (child.killed) return;
        log.warn(`${this.id} no ACP output for ${idleMs}ms; killing hung turn`);
        trace?.write({ stream: "idle_timeout", pid: child.pid, params: { idleMs } });
        state.errorText =
          state.errorText ??
          `${this.id} idle timeout: no output for ${idleMs}ms`;
        forceKill();
      }, idleMs);
      if (typeof idleTimer.unref === "function") idleTimer.unref();
    };

    let stderrTail = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      armIdle();
      stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_CAP);
      trace?.write({ stream: "stderr", pid: child.pid, chunk });
    });
    // Rearm on stdout too — AcpConnection installs its own `data` listener for
    // framing; this second listener only resets the watchdog (listeners coexist).
    child.stdout.on("data", () => armIdle());
    armIdle();

    const appendAssistantText = (text: string): void => {
      if (!text || state.assistantTextCapped) return;
      const budget = ASSISTANT_TEXT_CAP - state.assistantTextBytes;
      if (budget <= 0) {
        state.assistantTextCapped = true;
        return;
      }
      const bytes = utf8ByteLength(text);
      if (bytes > budget) {
        const chunk = sliceUtf8Bytes(text, budget);
        if (chunk) {
          state.assistantTextChunks.push(chunk);
          state.assistantTextBytes += utf8ByteLength(chunk);
        }
        state.assistantTextCapped = true;
        return;
      }
      state.assistantTextChunks.push(text);
      state.assistantTextBytes += bytes;
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
      trace,
    );

    const childExit = new Promise<number>((resolve) => {
      child.on("close", (code, signal) => {
        trace?.write({ stream: "child_exit", pid: child.pid, code, signal });
        resolve(code ?? 0);
      });
      child.on("error", (err) => {
        trace?.write({
          stream: "child_error",
          pid: child.pid,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    });

    let newSessionId = opts.sessionId ?? "";
    let promptStarted = false;

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
          if (!isRecoverableSessionLoadError(err)) {
            throw new Error(`session/load failed: ${err instanceof Error ? err.message : String(err)}`);
          }
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
      promptStarted = true;
      const promptResult = (await conn.request<unknown>("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: opts.text }],
      })) as { stopReason?: string } | null;

      const stopReason = promptResult?.stopReason ?? "end_turn";
      if (stopReason === "refusal" || stopReason === "error") {
        const tail = stderrTail.slice(-STDERR_ERROR_SNIPPET).trim();
        state.errorText =
          state.errorText ??
          (tail
            ? `prompt stopped: ${stopReason}; stderr: ${tail}`
            : `prompt stopped: ${stopReason}`);
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
      const baseMsg = err instanceof Error ? err.message : String(err);
      const tail = stderrTail.slice(-STDERR_ERROR_SNIPPET).trim();
      state.errorText =
        state.errorText ?? (tail ? `${baseMsg}; stderr: ${tail}` : baseMsg);
      if (promptStarted && !opts.signal.aborted) {
        await sleepUnlessAborted(PROMPT_ERROR_DRAIN_MS, opts.signal);
      }
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
      clearIdle();
    }

    if (code !== 0 && !state.errorText) {
      state.errorText = `${this.id} exited with code ${code}: ${stderrTail.slice(
        -STDERR_ERROR_SNIPPET,
      )}`;
    }

    const rawText =
      state.finalText || state.assistantTextChunks.join("").trim();
    const text =
      utf8ByteLength(rawText) > ASSISTANT_TEXT_CAP
        ? sliceUtf8Bytes(rawText, ASSISTANT_TEXT_CAP)
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

function formatRpcError(error: unknown): string {
  if (!error || typeof error !== "object") return "(no message)";
  const e = error as Record<string, unknown>;
  const message = typeof e.message === "string" && e.message ? e.message : "(no message)";
  const data = e.data;
  if (data === undefined || data === null) return message;
  let detail = "";
  if (typeof data === "string") {
    detail = data;
  } else {
    const dataObj = typeof data === "object" ? (data as Record<string, unknown>) : null;
    const details = dataObj && typeof dataObj.details === "string" ? dataObj.details : "";
    if (details) {
      detail = details;
    } else {
      try {
        detail = JSON.stringify(data);
      } catch {
        detail = String(data);
      }
    }
  }
  return detail ? `${message}: ${detail}` : message;
}

function isRecoverableSessionLoadError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    isSessionNotFoundError(err) ||
    /\bnot\s+found\b/i.test(msg) ||
    /method\s+not\s+found|unknown\s+method|not\s+implemented/i.test(msg)
  );
}

function isSessionNotFoundError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /session(?:\s+[\w-]+)?\s+not\s+found|no\s+session\s+found|unknown\s+session/i.test(
    msg,
  );
}

function sleepUnlessAborted(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(done, ms);
    if (typeof t.unref === "function") t.unref();
    function done(): void {
      signal.removeEventListener("abort", done);
      clearTimeout(t);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}
