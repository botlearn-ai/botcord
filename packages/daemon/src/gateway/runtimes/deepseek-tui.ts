import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import net from "node:net";
import { buildCliEnv } from "../cli-resolver.js";
import { consoleLogger } from "../log.js";
import {
  REPORT_PROGRESS_MAX_SUMMARY_LENGTH,
  reportProgressMcpServerPath,
} from "../../mcp/report-progress-server.js";
import { prependSystemRules } from "../../system-rules.js";
import {
  readCommandVersion,
  resolveCommandOnPath,
  type ProbeDeps,
} from "./probe.js";
import type {
  RuntimeAdapter,
  RuntimeProbeResult,
  RuntimeRunOptions,
  RuntimeRunResult,
  StreamBlock,
} from "../types.js";

const log = consoleLogger;

const DEEPSEEK_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
/**
 * Per-turn SSE watchdog. DeepSeek's HTTP server sends keep-alive comments even
 * when the underlying model turn has stopped producing runtime events, so this
 * must be reset only by parsed events (not by arbitrary response bytes).
 * 0 disables the watchdog.
 */
const DEFAULT_TURN_EVENT_IDLE_TIMEOUT_MS = 60_000;
/** Bound token-level reasoning deltas before they become durable Hub/Course events. */
const REASONING_PROGRESS_INTERVAL_MS = 4_000;
const STARTUP_TIMEOUT_MS = 30_000;
const STARTUP_POLL_MS = 250;
const SSE_TEXT_CAP = 1 * 1024 * 1024;
const REPORT_PROGRESS_RUNTIME_TOOL_NAMES = new Set([
  "report_progress",
  "mcp_botlearn_report_progress",
  "mcp__botlearn__report_progress",
]);
const REPORT_PROGRESS_SYSTEM_INSTRUCTIONS = [
  "[BotCord User-Visible Progress]",
  "For non-trivial work, call mcp_botlearn_report_progress after understanding the task and at meaningful phase boundaries.",
  "Use status=in_progress while work continues and status=completed only when a meaningful phase has finished.",
  "Keep summary to one short factual sentence about completed work or the next visible action.",
  "Never include hidden reasoning, secrets, credentials, raw tool output, or unsupported claims.",
  "This tool reports UI progress only. It does not complete a course task, replace the final answer, or prove acceptance criteria.",
  "Do not call it for trivial requests or for every low-level tool invocation.",
].join("\n");

interface DeepseekProgressReport {
  summary: string;
  status: "in_progress" | "completed";
}

interface DeepseekProcessHandle {
  child: ChildProcess;
  baseUrl: string;
  token: string;
  closed: boolean;
  inFlight: number;
  idleTimer?: NodeJS.Timeout;
  stderrTail: string;
}

interface DeepseekAdapterDeps {
  binary?: string;
  /** Test seam: use an already-running compatible server instead of spawning `deepseek`. */
  serverUrl?: string;
  authToken?: string;
  turnEventIdleTimeoutMs?: number;
  fetchFn?: typeof fetch;
  spawnFn?: typeof spawn;
}

class DeepseekTurnEventIdleError extends Error {
  constructor(timeoutMs: number) {
    super(`event stream produced no runtime event for ${timeoutMs}ms`);
    this.name = "DeepseekTurnEventIdleError";
  }
}

const PROCESS_POOL = new Map<string, DeepseekProcessHandle>();

let exitCleanupHookInstalled = false;

/**
 * Kill any pooled deepseek servers when the daemon exits. The pool is
 * in-memory, so without this a daemon restart orphans the spawned servers.
 * Installed lazily on first spawn to keep module import side-effect free.
 */
function installExitCleanupHook(): void {
  if (exitCleanupHookInstalled) return;
  exitCleanupHookInstalled = true;
  process.once("exit", () => {
    for (const [key, handle] of PROCESS_POOL.entries()) {
      shutdownHandle(handle, "daemon-exit");
      PROCESS_POOL.delete(key);
    }
  });
}

/** Resolve the `deepseek` dispatcher CLI on PATH. */
export function resolveDeepseekCommand(deps: ProbeDeps = {}): string | null {
  const explicit = (deps.env ?? process.env).BOTCORD_DEEPSEEK_TUI_BIN;
  if (explicit && explicit.length > 0) return explicit;
  const onPath = resolveCommandOnPath("deepseek", deps);
  if (!onPath) return null;
  return resolveDownloadedDeepseekBinary(onPath, deps) ?? onPath;
}

/** Probe whether DeepSeek TUI is installed and report its version. */
export function probeDeepseekTui(deps: ProbeDeps = {}): RuntimeProbeResult {
  const command = resolveDeepseekCommand(deps);
  if (!command) return { available: false };
  return {
    available: true,
    path: command,
    version: readCommandVersion(command, [], deps) ?? undefined,
  };
}

/**
 * DeepSeek TUI adapter.
 *
 * Drives the headless runtime API exposed by `deepseek serve --http`, not the
 * interactive TUI and not ACP. The HTTP/SSE API is the documented complete
 * runtime surface; ACP is currently a conservative editor baseline.
 */
export class DeepseekTuiAdapter implements RuntimeAdapter {
  readonly id = "deepseek-tui" as const;

  private readonly explicitBinary: string | undefined;
  private readonly explicitServerUrl: string | undefined;
  private readonly explicitAuthToken: string | undefined;
  private readonly turnEventIdleTimeoutMs: number;
  private readonly fetchFn: typeof fetch;
  private readonly spawnFn: typeof spawn;
  private resolvedBinary: string | null = null;

  constructor(deps: DeepseekAdapterDeps = {}) {
    this.explicitBinary = deps.binary ?? process.env.BOTCORD_DEEPSEEK_TUI_BIN;
    this.explicitServerUrl = deps.serverUrl ?? process.env.BOTCORD_DEEPSEEK_TUI_URL;
    this.explicitAuthToken = deps.authToken ?? process.env.BOTCORD_DEEPSEEK_TUI_TOKEN;
    this.turnEventIdleTimeoutMs =
      deps.turnEventIdleTimeoutMs ?? deepseekTurnEventIdleTimeoutMs();
    this.fetchFn = deps.fetchFn ?? fetch;
    this.spawnFn = deps.spawnFn ?? spawn;
  }

  probe(): RuntimeProbeResult {
    return probeDeepseekTui();
  }

  async run(opts: RuntimeRunOptions): Promise<RuntimeRunResult> {
    if (opts.signal.aborted) {
      return {
        text: "",
        newSessionId: opts.sessionId ?? "",
        error: "deepseek-tui aborted before start",
      };
    }

    const handle = await this.acquireHandle(opts);
    handle.inFlight += 1;
    if (handle.idleTimer) clearTimeout(handle.idleTimer);

    const turnAbort = new AbortController();
    const onAbort = () => turnAbort.abort();
    opts.signal.addEventListener("abort", onAbort, { once: true });

    try {
      const headers = authHeaders(handle.token);
      let threadId = opts.sessionId?.trim() || "";
      if (threadId && !isValidThreadId(threadId)) {
        return {
          text: "",
          newSessionId: "",
          error: "deepseek-tui: invalid sessionId",
        };
      }

      if (!threadId) {
        threadId = await this.createThread(handle.baseUrl, headers, opts, turnAbort.signal);
      } else if (
        opts.systemContext !== undefined ||
        opts.systemRules?.length ||
        this.progressReportingEnabled(opts)
      ) {
        await this.patchThreadSystemContext(
          handle.baseUrl,
          headers,
          threadId,
          this.systemPrompt(opts),
          turnAbort.signal,
        );
      }

      const runResult = await this.startTurnAndReadEvents({
        baseUrl: handle.baseUrl,
        headers,
        threadId,
        opts,
        signal: turnAbort.signal,
      });
      const text = runResult.text;
      const error =
        runResult.error ??
        (text === "" ? emptyCompletionError(handle.stderrTail) : undefined);

      return {
        text,
        newSessionId: threadId,
        ...(error ? { error } : {}),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const turnEventIdle = err instanceof DeepseekTurnEventIdleError;
      if (turnEventIdle && !this.explicitServerUrl) {
        // Closing the SSE client does not guarantee that the local runtime
        // cancels its in-flight provider request. Reap the whole process group
        // so a silent turn cannot keep consuming resources or contaminate the
        // next turn; the next adapter run will start a clean server.
        shutdownHandle(handle, "turn-event-idle-timeout");
        PROCESS_POOL.delete(poolKey(opts));
      }
      const staleSession = opts.sessionId && /404|not found|missing/i.test(message);
      return {
        text: "",
        newSessionId: staleSession || turnEventIdle ? "" : opts.sessionId ?? "",
        error: `deepseek-tui: ${message}`,
      };
    } finally {
      opts.signal.removeEventListener("abort", onAbort);
      handle.inFlight -= 1;
      if (!this.explicitServerUrl) resetIdle(handle, poolKey(opts));
    }
  }

  private resolveBinary(): string {
    if (this.explicitBinary) return this.explicitBinary;
    if (this.resolvedBinary) return this.resolvedBinary;
    this.resolvedBinary = resolveDeepseekCommand() ?? "deepseek";
    return this.resolvedBinary;
  }

  private async acquireHandle(opts: RuntimeRunOptions): Promise<DeepseekProcessHandle> {
    if (this.explicitServerUrl) {
      return {
        child: nullChild(),
        baseUrl: trimTrailingSlash(this.explicitServerUrl),
        token: this.explicitAuthToken ?? "",
        closed: false,
        inFlight: 0,
        stderrTail: "",
      };
    }

    const key = poolKey(opts);
    const existing = PROCESS_POOL.get(key);
    if (existing && !existing.closed) return existing;

    const port = await findFreePort();
    const token = randomToken();
    const baseUrl = `http://127.0.0.1:${port}`;
    const child = this.spawnFn(
      this.resolveBinary(),
      ["serve", "--http", "--host", "127.0.0.1", "--port", String(port), "--auth-token", token],
      {
        cwd: opts.cwd,
        env: this.spawnEnv(opts),
        stdio: ["ignore", "pipe", "pipe"],
        // Own process group: the resolved binary may be a dispatcher that
        // re-spawns the real deepseek-tui server, so shutdown must signal
        // the whole group, not just the direct child.
        detached: true,
      },
    );
    installExitCleanupHook();

    const handle: DeepseekProcessHandle = {
      child,
      baseUrl,
      token,
      closed: false,
      inFlight: 0,
      stderrTail: "",
    };
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      handle.stderrTail = (handle.stderrTail + chunk).slice(-4096);
    });
    child.on("close", () => {
      handle.closed = true;
      PROCESS_POOL.delete(key);
    });
    child.on("error", () => {
      handle.closed = true;
      PROCESS_POOL.delete(key);
    });

    await waitForHealth(baseUrl, this.fetchFn, child, STARTUP_TIMEOUT_MS);
    PROCESS_POOL.set(key, handle);
    resetIdle(handle, key);
    return handle;
  }

  private spawnEnv(opts: RuntimeRunOptions): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...buildCliEnv({
        hubUrl: opts.hubUrl,
        accountId: opts.accountId,
        basePath: process.env.PATH,
        waitMarkerFile: opts.waitMarkerFile,
      }),
      FORCE_COLOR: "0",
      NO_COLOR: "1",
    };
    if (opts.accountId) {
      const agentHome = agentDeepseekHomeDir(opts.accountId);
      const runtimeDir = path.join(agentHome, "runtime");
      mkdirSync(runtimeDir, { recursive: true });
      env.DEEPSEEK_RUNTIME_DIR = runtimeDir;
      env.DEEPSEEK_MCP_CONFIG = writeReportProgressMcpConfig(
        path.join(agentHome, "mcp.json"),
      );
    }
    return env;
  }

  private systemPrompt(opts: RuntimeRunOptions): string | undefined {
    const base = prependSystemRules(opts.systemContext, opts.systemRules);
    return withReportProgressSystemPrompt(base, this.progressReportingEnabled(opts));
  }

  private progressReportingEnabled(opts: RuntimeRunOptions): boolean {
    return !this.explicitServerUrl && !!opts.accountId;
  }

  private async createThread(
    baseUrl: string,
    headers: HeadersInit,
    opts: RuntimeRunOptions,
    signal: AbortSignal,
  ): Promise<string> {
    const body: Record<string, unknown> = {
      workspace: opts.cwd,
      mode: "agent",
      allow_shell: opts.trustLevel !== "public",
      trust_mode: opts.trustLevel !== "public",
      auto_approve: opts.trustLevel !== "public",
      archived: false,
    };
    const selection = parseDeepseekRuntimeSelection(opts.extraArgs);
    if (selection.model) body.model = selection.model;
    if (selection.reasoningEffort) body.reasoning_effort = selection.reasoningEffort;
    const systemPrompt = this.systemPrompt(opts);
    if (systemPrompt) body.system_prompt = systemPrompt;
    const res = await this.requestJson<any>(`${baseUrl}/v1/threads`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal,
    });
    const id = stringField(res, "id") ?? stringField(res, "thread_id");
    if (!id) throw new Error("create thread response missing id");
    return id;
  }

  private async patchThreadSystemContext(
    baseUrl: string,
    headers: HeadersInit,
    threadId: string,
    systemContext: string | undefined,
    signal: AbortSignal,
  ): Promise<void> {
    await this.requestJson(`${baseUrl}/v1/threads/${encodeURIComponent(threadId)}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ system_prompt: systemContext ?? "" }),
      signal,
    });
  }

  private async startTurnAndReadEvents(args: {
    baseUrl: string;
    headers: HeadersInit;
    threadId: string;
    opts: RuntimeRunOptions;
    signal: AbortSignal;
  }): Promise<{ text: string; error?: string }> {
    const { baseUrl, headers, threadId, opts, signal } = args;
    const eventsUrl = `${baseUrl}/v1/threads/${encodeURIComponent(threadId)}/events?since_seq=0`;
    const eventsAbort = new AbortController();
    const onAbort = () => eventsAbort.abort();
    signal.addEventListener("abort", onAbort, { once: true });
    let eventsError: unknown;
    const eventsReaderPromise = this.readEvents(eventsUrl, headers, opts, eventsAbort.signal).catch((err) => {
      eventsError = err;
      return null;
    });
    let turnId = "";
    try {
      const selection = parseDeepseekRuntimeSelection(opts.extraArgs);
      const body: Record<string, unknown> = {
        prompt: opts.text,
        mode: "agent",
        allow_shell: opts.trustLevel !== "public",
        trust_mode: opts.trustLevel !== "public",
        auto_approve: opts.trustLevel !== "public",
      };
      if (selection.model) body.model = selection.model;
      if (selection.reasoningEffort) body.reasoning_effort = selection.reasoningEffort;
      const started = await this.requestJson<any>(
        `${baseUrl}/v1/threads/${encodeURIComponent(threadId)}/turns`,
        {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal,
        },
      );
      turnId = stringField(started?.turn, "id") ?? stringField(started, "turn_id") ?? "";
      const eventsReader = await eventsReaderPromise;
      if (!eventsReader) throw eventsError ?? new Error("events stream failed");
      return await eventsReader(turnId);
    } catch (err) {
      throw err;
    } finally {
      eventsAbort.abort();
      signal.removeEventListener("abort", onAbort);
    }
  }

  private async readEvents(
    url: string,
    headers: HeadersInit,
    opts: RuntimeRunOptions,
    signal: AbortSignal,
  ): Promise<(turnId: string) => Promise<{ text: string; error?: string }>> {
    const res = await this.fetchFn(url, { method: "GET", headers, signal });
    if (!res.ok) throw new Error(`events stream failed HTTP ${res.status}`);
    if (!res.body) throw new Error("events stream response missing body");
    const reader = res.body.getReader();

    return async (turnId: string) => {
      const decoder = new TextDecoder();
      let buf = "";
      let seq = 0;
      let text = "";
      let errorText = "";
      let capped = false;
      let lastReasoningProgressAt = 0;
      const progressToolIds = new Set<string>();
      let idleTimer: NodeJS.Timeout | undefined;
      let rejectIdle: ((err: Error) => void) | undefined;
      const idleFailure = new Promise<never>((_resolve, reject) => {
        rejectIdle = reject;
      });
      const clearEventIdle = () => {
        if (!idleTimer) return;
        clearTimeout(idleTimer);
        idleTimer = undefined;
      };
      const armEventIdle = () => {
        if (this.turnEventIdleTimeoutMs <= 0) return;
        clearEventIdle();
        idleTimer = setTimeout(() => {
          rejectIdle?.(new DeepseekTurnEventIdleError(this.turnEventIdleTimeoutMs));
        }, this.turnEventIdleTimeoutMs);
        idleTimer.unref?.();
      };
      const append = (chunk: string) => {
        if (!chunk || capped) return;
        const budget = SSE_TEXT_CAP - Buffer.byteLength(text, "utf8");
        if (budget <= 0) {
          capped = true;
          return;
        }
        if (Buffer.byteLength(chunk, "utf8") > budget) {
          text += chunk.slice(0, budget);
          capped = true;
          return;
        }
        text += chunk;
      };

      const emit = (eventName: string, payload: any): boolean => {
        const eventTurnId = stringField(payload, "turn_id") ?? stringField(payload?.payload, "turn_id");
        if (turnId && eventTurnId && eventTurnId !== turnId) return false;
        seq += 1;
        let block = normalizeDeepseekEvent(eventName, payload, seq, progressToolIds);
        if (block?.kind === "thinking" && eventName === "item.delta") {
          const now = Date.now();
          if (now - lastReasoningProgressAt < REASONING_PROGRESS_INTERVAL_MS) {
            block = null;
          } else {
            lastReasoningProgressAt = now;
          }
        }
        if (block) opts.onBlock?.(block);
        const extractedError = extractDeepseekError(eventName, payload);
        if (extractedError) errorText = extractedError;
        if (eventName === "message.delta") {
          append(stringField(payload, "content") ?? "");
        } else if (eventName === "item.delta" && isAgentMessageDelta(payload)) {
          append(extractDeepseekDelta(payload));
        }
        if (eventName === "turn.started" || embeddedDeepseekEvent(payload) === "turn.started") {
          opts.onStatus?.({ kind: "thinking", phase: "started", label: "Thinking" });
        } else if (
          (eventName === "tool.started" || isToolStarted(eventName, payload)) &&
          !isReportProgressToolName(deepseekToolName(payload))
        ) {
          const label =
            stringField(payload, "name") ??
            stringField(payload?.tool, "name") ??
            stringField(payload?.payload?.tool, "name") ??
            inferDeepseekToolName(payload?.item ?? payload?.payload?.item) ??
            "tool";
          opts.onStatus?.({ kind: "thinking", phase: "updated", label });
        } else if (isDeepseekTerminalEvent(eventName, payload)) {
          opts.onStatus?.({ kind: "thinking", phase: "stopped" });
          return true;
        }
        return false;
      };

      armEventIdle();
      try {
        while (true) {
          const { value, done } = await Promise.race([reader.read(), idleFailure]);
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let idx: number;
          while ((idx = buf.indexOf("\n\n")) !== -1) {
            const frame = parseSseFrame(buf.slice(0, idx));
            buf = buf.slice(idx + 2);
            if (!frame) continue;
            const eventTurnId =
              stringField(frame.data, "turn_id") ??
              stringField(frame.data?.payload, "turn_id");
            if (!turnId || !eventTurnId || eventTurnId === turnId) armEventIdle();
            if (emit(frame.event, frame.data)) {
              await reader.cancel().catch(() => undefined);
              return { text: text.trim(), ...(errorText ? { error: errorText } : {}) };
            }
          }
        }
        if (buf.trim()) {
          const frame = parseSseFrame(buf);
          if (frame) emit(frame.event, frame.data);
        }
        return { text: text.trim(), ...(errorText ? { error: errorText } : {}) };
      } finally {
        clearEventIdle();
      }
    };
  }

  private async requestJson<T>(url: string, init: RequestInit): Promise<T> {
    const headers = new Headers(init.headers);
    if (!headers.has("content-type") && init.body) headers.set("content-type", "application/json");
    const res = await this.fetchFn(url, { ...init, headers });
    if (!res.ok) {
      let detail = "";
      try {
        detail = await res.text();
      } catch {
        // ignore
      }
      throw new Error(`HTTP ${res.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`);
    }
    return (await res.json()) as T;
  }
}

export function __resetDeepseekTuiPoolForTests(): void {
  for (const [key, handle] of PROCESS_POOL.entries()) {
    shutdownHandle(handle, "test-reset");
    PROCESS_POOL.delete(key);
  }
}

function normalizeDeepseekEvent(
  eventName: string,
  payload: any,
  seq: number,
  progressToolIds: Set<string>,
): StreamBlock | null {
  if (eventName === "message.delta") {
    return { raw: { event: eventName, payload }, kind: "assistant_text", seq };
  }
  if (eventName === "tool.started" || isToolStarted(eventName, payload)) {
    const toolName = deepseekToolName(payload);
    if (isReportProgressToolName(toolName)) {
      for (const id of deepseekToolIds(payload)) progressToolIds.add(id);
      const report = deepseekProgressReport(payload);
      if (!report) return null;
      return {
        raw: { ...report, source: "report_progress" },
        kind: "progress",
        seq,
      };
    }
    return { raw: { event: eventName, payload }, kind: "tool_use", seq };
  }
  if (eventName === "tool.completed" || isToolCompleted(eventName, payload)) {
    const ids = deepseekToolIds(payload);
    const isProgressCompletion =
      isReportProgressToolName(deepseekToolName(payload)) ||
      ids.some((id) => progressToolIds.has(id));
    if (isProgressCompletion) {
      for (const id of ids) progressToolIds.delete(id);
      return null;
    }
    return { raw: { event: eventName, payload }, kind: "tool_result", seq };
  }
  if (eventName === "item.delta" && isAgentMessageDelta(payload)) {
    return { raw: { event: eventName, payload }, kind: "assistant_text", seq };
  }
  if (eventName === "item.delta" && isAgentReasoningDelta(payload)) {
    // DeepSeek 0.8.39 streams thinking as item.delta/agent_reasoning. Forward
    // only a lifecycle marker: the raw reasoning text is private chain of
    // thought and must not enter Hub frames, transcripts, or Course storage.
    return {
      raw: { event: eventName, phase: "updated", label: "Reasoning", source: "runtime" },
      kind: "thinking",
      seq,
    };
  }
  if (eventName === "item.completed" && isAgentReasoningItem(payload)) {
    return {
      raw: { event: eventName, phase: "updated", label: "Reasoning", source: "runtime" },
      kind: "thinking",
      seq,
    };
  }
  if (eventName === "turn.started" || eventName === "status" || embeddedDeepseekEvent(payload) === "turn.started") {
    return { raw: { event: eventName, payload }, kind: "system", seq };
  }
  if (eventName === "error" || isDeepseekTerminalEvent(eventName, payload)) {
    return { raw: { event: eventName, payload }, kind: "other", seq };
  }
  return null;
}

function embeddedDeepseekEvent(payload: any): string | undefined {
  return stringField(payload, "event") ?? stringField(payload?.payload, "event");
}

function isDeepseekTerminalEvent(eventName: string, payload: any): boolean {
  const embedded = embeddedDeepseekEvent(payload);
  return (
    eventName === "turn.completed" ||
    eventName === "turn.finished" ||
    eventName === "turn.done" ||
    eventName === "done" ||
    embedded === "turn.completed" ||
    embedded === "turn.finished" ||
    embedded === "turn.done" ||
    embedded === "done"
  );
}

function isToolStarted(eventName: string, payload: any): boolean {
  const itemKind = payload?.payload?.item?.kind ?? payload?.item?.kind;
  return (
    (eventName === "item.started" &&
      (
        !!payload?.tool ||
        itemKind === "tool_call" ||
        itemKind === "command_execution" ||
        itemKind === "file_change"
      )) ||
    (payload?.event === "item.started" && !!payload?.payload?.tool)
  );
}

function isToolCompleted(eventName: string, payload: any): boolean {
  const kind = payload?.payload?.item?.kind ?? payload?.item?.kind;
  return (
    (eventName === "item.completed" ||
      eventName === "item.failed" ||
      payload?.event === "item.completed" ||
      payload?.event === "item.failed") &&
    (kind === "tool_call" || kind === "file_change" || kind === "command_execution")
  );
}

function isAgentMessageDelta(payload: any): boolean {
  return payload?.kind === "agent_message" || payload?.payload?.kind === "agent_message";
}

function isAgentReasoningDelta(payload: any): boolean {
  return payload?.kind === "agent_reasoning" || payload?.payload?.kind === "agent_reasoning";
}

function isAgentReasoningItem(payload: any): boolean {
  return payload?.item?.kind === "agent_reasoning" || payload?.payload?.item?.kind === "agent_reasoning";
}

function extractDeepseekDelta(payload: any): string {
  return stringField(payload, "delta") ?? stringField(payload?.payload, "delta") ?? "";
}

function inferDeepseekToolName(item: any): string | undefined {
  const candidates = [stringField(item, "summary"), stringField(item, "detail")];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const match = candidate.match(/^([A-Za-z0-9_.:-]+)\s*(?:started|completed|failed|returned|:)/);
    if (match?.[1] && match[1] !== "tool_call") return match[1];
  }
  return undefined;
}

function deepseekPayloadLayers(payload: any): any[] {
  const layers = [payload, payload?.payload, payload?.payload?.payload];
  return layers.filter((value, index) => (
    value && typeof value === "object" && layers.indexOf(value) === index
  ));
}

function deepseekToolName(payload: any): string | undefined {
  for (const layer of deepseekPayloadLayers(payload)) {
    const tool = layer.tool && typeof layer.tool === "object" ? layer.tool : undefined;
    const item = layer.item && typeof layer.item === "object" ? layer.item : undefined;
    const name =
      stringField(layer, "name") ??
      stringField(tool, "name") ??
      stringField(item, "name") ??
      inferDeepseekToolName(item);
    if (name) return name;
  }
  return undefined;
}

function isReportProgressToolName(name: string | undefined): boolean {
  return !!name && REPORT_PROGRESS_RUNTIME_TOOL_NAMES.has(name.trim().toLowerCase());
}

function deepseekToolIds(payload: any): string[] {
  const ids = new Set<string>();
  for (const layer of deepseekPayloadLayers(payload)) {
    const tool = layer.tool && typeof layer.tool === "object" ? layer.tool : undefined;
    const item = layer.item && typeof layer.item === "object" ? layer.item : undefined;
    for (const value of [
      stringField(layer, "id"),
      stringField(layer, "item_id"),
      stringField(tool, "id"),
      stringField(item, "id"),
    ]) {
      if (value) ids.add(value);
    }
  }
  return [...ids];
}

function progressInput(payload: any): Record<string, unknown> | null {
  for (const layer of deepseekPayloadLayers(payload)) {
    const tool = layer.tool && typeof layer.tool === "object" ? layer.tool : undefined;
    const item = layer.item && typeof layer.item === "object" ? layer.item : undefined;
    const candidates = [
      layer.input,
      layer.arguments,
      layer.params,
      tool?.input,
      tool?.arguments,
      tool?.params,
      item?.input,
      item?.arguments,
      item?.params,
      item?.detail,
    ];
    for (const candidate of candidates) {
      if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
        return candidate as Record<string, unknown>;
      }
      if (typeof candidate === "string") {
        try {
          const parsed = JSON.parse(candidate);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            return parsed as Record<string, unknown>;
          }
        } catch {
          // Ignore display-only detail strings that are not JSON tool arguments.
        }
      }
    }
  }
  return null;
}

function deepseekProgressReport(payload: any): DeepseekProgressReport | null {
  const input = progressInput(payload);
  if (!input) return null;
  const summary = typeof input.summary === "string" ? input.summary.trim() : "";
  const status = input.status;
  if (!summary || (status !== "in_progress" && status !== "completed")) return null;
  return {
    summary: summary.slice(0, REPORT_PROGRESS_MAX_SUMMARY_LENGTH),
    status,
  };
}

function emptyCompletionError(stderrTail: string): string {
  const tail = stderrTail.trim();
  if (!tail) {
    return "deepseek runtime completed with no assistant_message (check DEEPSEEK_API_KEY / model availability)";
  }
  const lines = tail.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const lastLines = lines.slice(-5).join("\n").slice(-500);
  return `deepseek runtime completed with no assistant_message; stderr tail: ${lastLines}`;
}

function extractDeepseekError(eventName: string, payload: any): string | undefined {
  if (eventName === "error") {
    return (
      stringField(payload, "message") ??
      stringField(payload, "error") ??
      stringField(payload?.payload, "message") ??
      stringField(payload?.payload, "error")
    );
  }
  if (eventName === "item.failed") {
    return (
      stringField(payload?.payload?.item, "detail") ??
      stringField(payload?.payload?.item, "summary") ??
      stringField(payload?.payload, "error")
    );
  }
  if (isDeepseekTerminalEvent(eventName, payload)) {
    const turn = payload?.payload?.turn ?? payload?.turn;
    const status = stringField(turn, "status");
    const err = stringField(turn, "error");
    if (err) return err;
    if (status && status !== "completed") return `DeepSeek turn ${status}`;
  }
  return undefined;
}

function parseSseFrame(raw: string): { event: string; data: any } | null {
  let event = "message";
  const dataLines: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith("event:")) event = line.slice("event:".length).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice("data:".length).trimStart());
  }
  if (dataLines.length === 0) return null;
  try {
    return { event, data: JSON.parse(dataLines.join("\n")) };
  } catch {
    return { event, data: { content: dataLines.join("\n") } };
  }
}

function authHeaders(token: string): HeadersInit {
  return token ? { authorization: `Bearer ${token}` } : {};
}

function parseDeepseekRuntimeSelection(
  extraArgs: string[] | undefined,
): { model?: string; reasoningEffort?: string } {
  const out: { model?: string; reasoningEffort?: string } = {};
  if (!extraArgs?.length) return out;
  for (let i = 0; i < extraArgs.length; i += 1) {
    const arg = extraArgs[i]!;
    if (arg === "--model") {
      const value = nextArgValue(extraArgs, i);
      if (value !== undefined) {
        out.model = value;
        i += 1;
      }
    } else if (arg.startsWith("--model=")) {
      out.model = arg.slice("--model=".length);
    } else if (arg === "--reasoning-effort") {
      const value = nextArgValue(extraArgs, i);
      if (value !== undefined) {
        out.reasoningEffort = value;
        i += 1;
      }
    } else if (arg.startsWith("--reasoning-effort=")) {
      out.reasoningEffort = arg.slice("--reasoning-effort=".length);
    }
  }
  return out;
}

function nextArgValue(args: string[], index: number): string | undefined {
  const next = args[index + 1];
  if (typeof next !== "string") return undefined;
  if (!next.startsWith("-")) return next;
  return /^-\d/.test(next) ? next : undefined;
}

function poolKey(opts: RuntimeRunOptions): string {
  return opts.accountId || "default";
}

function resetIdle(handle: DeepseekProcessHandle, key: string): void {
  if (handle.idleTimer) clearTimeout(handle.idleTimer);
  if (handle.inFlight > 0 || handle.closed) return;
  handle.idleTimer = setTimeout(() => {
    if (handle.inFlight === 0 && !handle.closed) {
      log.info("deepseek-tui.idle-timeout", { key });
      shutdownHandle(handle, "idle-timeout");
      PROCESS_POOL.delete(key);
    }
  }, DEEPSEEK_IDLE_TIMEOUT_MS);
  handle.idleTimer.unref?.();
}

function shutdownHandle(handle: DeepseekProcessHandle, reason: string): void {
  if (handle.closed) return;
  handle.closed = true;
  if (handle.idleTimer) clearTimeout(handle.idleTimer);
  try {
    const pid = handle.child.pid;
    if (typeof pid === "number" && pid > 0) {
      // Negative pid signals the process group (see detached spawn above),
      // killing the dispatcher and the deepseek-tui server it re-spawned.
      process.kill(-pid, "SIGTERM");
    } else {
      handle.child.kill("SIGTERM");
    }
  } catch {
    try {
      handle.child.kill("SIGTERM");
    } catch {
      // no-op
    }
  }
  try {
    handle.child.stdout?.destroy();
    handle.child.stderr?.destroy();
    handle.child.stdin?.destroy();
    handle.child.unref();
  } catch {
    // no-op
  }
  log.debug("deepseek-tui.shutdown", { reason });
}

async function waitForHealth(
  baseUrl: string,
  fetchFn: typeof fetch,
  child: ChildProcess,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "";
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`deepseek serve exited with code ${child.exitCode}`);
    }
    try {
      const res = await fetchFn(`${baseUrl}/health`, { method: "GET" });
      if (res.ok) return;
      lastError = `HTTP ${res.status}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await sleep(STARTUP_POLL_MS);
  }
  throw new Error(`deepseek serve did not become healthy: ${lastError}`);
}

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      srv.close(() => {
        if (typeof addr === "object" && addr?.port) resolve(addr.port);
        else reject(new Error("failed to allocate port"));
      });
    });
  });
}

function randomToken(): string {
  return `bc_ds_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stringField(obj: any, key: string): string | undefined {
  const v = obj?.[key];
  return typeof v === "string" ? v : undefined;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function deepseekTurnEventIdleTimeoutMs(): number {
  const raw = process.env.BOTCORD_DEEPSEEK_TURN_IDLE_TIMEOUT_MS;
  if (raw === undefined || raw === "") return DEFAULT_TURN_EVENT_IDLE_TIMEOUT_MS;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : DEFAULT_TURN_EVENT_IDLE_TIMEOUT_MS;
}

function isValidThreadId(id: string): boolean {
  return id.length > 0 && id.length <= 256 && !/[\u0000-\u001f\u007f]/.test(id);
}

function resolveDownloadedDeepseekBinary(onPath: string, deps: ProbeDeps = {}): string | null {
  const exists = deps.existsSyncFn ?? existsSync;
  try {
    const resolved = realpathSync(onPath);
    const candidate = path.join(path.dirname(resolved), "downloads", "deepseek");
    return exists(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

function agentDeepseekHomeDir(accountId: string): string {
  return path.join(homedir(), ".botcord", "agents", accountId, "deepseek-tui");
}

function writeReportProgressMcpConfig(configPath: string, serverPath = reportProgressMcpServerPath()): string {
  mkdirSync(path.dirname(configPath), { recursive: true });
  const config = {
    servers: {
      botlearn: {
        command: process.execPath,
        args: [serverPath],
        env: {},
        disabled: false,
        required: true,
      },
    },
  };
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  chmodSync(configPath, 0o600);
  return configPath;
}

export { writeReportProgressMcpConfig as __writeReportProgressMcpConfigForTests };

function withReportProgressSystemPrompt(base: string | undefined, enabled: boolean): string | undefined {
  if (!enabled) return base;
  return base
    ? `${REPORT_PROGRESS_SYSTEM_INSTRUCTIONS}\n\n${base}`
    : REPORT_PROGRESS_SYSTEM_INSTRUCTIONS;
}

export { withReportProgressSystemPrompt as __withReportProgressSystemPromptForTests };

function nullChild(): ChildProcess {
  return {
    kill: () => true,
    on: () => nullChild(),
    stderr: { setEncoding: () => undefined, on: () => undefined } as any,
    stdout: { setEncoding: () => undefined, on: () => undefined } as any,
    stdin: { write: () => true } as any,
    exitCode: null,
  } as any;
}
