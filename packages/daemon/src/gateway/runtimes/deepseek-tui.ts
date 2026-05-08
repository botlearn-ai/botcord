import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import net from "node:net";
import { buildCliEnv } from "../cli-resolver.js";
import { consoleLogger } from "../log.js";
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
const STARTUP_TIMEOUT_MS = 30_000;
const STARTUP_POLL_MS = 250;
const SSE_TEXT_CAP = 1 * 1024 * 1024;

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
  fetchFn?: typeof fetch;
  spawnFn?: typeof spawn;
}

const PROCESS_POOL = new Map<string, DeepseekProcessHandle>();

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
  private readonly fetchFn: typeof fetch;
  private readonly spawnFn: typeof spawn;
  private resolvedBinary: string | null = null;

  constructor(deps: DeepseekAdapterDeps = {}) {
    this.explicitBinary = deps.binary ?? process.env.BOTCORD_DEEPSEEK_TUI_BIN;
    this.explicitServerUrl = deps.serverUrl ?? process.env.BOTCORD_DEEPSEEK_TUI_URL;
    this.explicitAuthToken = deps.authToken ?? process.env.BOTCORD_DEEPSEEK_TUI_TOKEN;
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
      } else if (opts.systemContext !== undefined) {
        await this.patchThreadSystemContext(
          handle.baseUrl,
          headers,
          threadId,
          opts.systemContext,
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

      return {
        text,
        newSessionId: threadId,
        ...(runResult.error ? { error: runResult.error } : {}),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const staleSession = opts.sessionId && /404|not found|missing/i.test(message);
      return {
        text: "",
        newSessionId: staleSession ? "" : opts.sessionId ?? "",
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
      },
    );

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
      }),
      FORCE_COLOR: "0",
      NO_COLOR: "1",
    };
    if (opts.accountId) {
      const runtimeDir = path.join(agentDeepseekHomeDir(opts.accountId), "runtime");
      mkdirSync(runtimeDir, { recursive: true });
      env.DEEPSEEK_RUNTIME_DIR = runtimeDir;
    }
    return env;
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
    if (opts.systemContext) body.system_prompt = opts.systemContext;
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
      const started = await this.requestJson<any>(
        `${baseUrl}/v1/threads/${encodeURIComponent(threadId)}/turns`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            prompt: opts.text,
            mode: "agent",
            allow_shell: opts.trustLevel !== "public",
            trust_mode: opts.trustLevel !== "public",
            auto_approve: opts.trustLevel !== "public",
          }),
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
        const block = normalizeDeepseekEvent(eventName, payload, seq);
        if (block) opts.onBlock?.(block);
        const extractedError = extractDeepseekError(eventName, payload);
        if (extractedError) errorText = extractedError;
        if (eventName === "message.delta") {
          append(stringField(payload, "content") ?? "");
        } else if (eventName === "item.delta" && payload?.payload?.kind === "agent_message") {
          append(stringField(payload.payload, "delta") ?? "");
        }
        if (eventName === "turn.started") {
          opts.onStatus?.({ kind: "thinking", phase: "started", label: "Thinking" });
        } else if (eventName === "tool.started" || isToolStarted(payload)) {
          const label = stringField(payload, "name") ?? stringField(payload?.payload?.tool, "name") ?? "tool";
          opts.onStatus?.({ kind: "thinking", phase: "updated", label });
        } else if (eventName === "turn.completed" || eventName === "done") {
          opts.onStatus?.({ kind: "thinking", phase: "stopped" });
          return true;
        }
        return false;
      };

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf("\n\n")) !== -1) {
          const frame = parseSseFrame(buf.slice(0, idx));
          buf = buf.slice(idx + 2);
          if (!frame) continue;
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

function normalizeDeepseekEvent(eventName: string, payload: any, seq: number): StreamBlock | null {
  if (eventName === "message.delta") {
    return { raw: { event: eventName, payload }, kind: "assistant_text", seq };
  }
  if (eventName === "tool.started" || isToolStarted(payload)) {
    return { raw: { event: eventName, payload }, kind: "tool_use", seq };
  }
  if (eventName === "tool.completed" || isToolCompleted(payload)) {
    return { raw: { event: eventName, payload }, kind: "tool_result", seq };
  }
  if (eventName === "item.delta" && payload?.payload?.kind === "agent_message") {
    return { raw: { event: eventName, payload }, kind: "assistant_text", seq };
  }
  if (eventName === "turn.started" || eventName === "status") {
    return { raw: { event: eventName, payload }, kind: "system", seq };
  }
  if (eventName === "error" || eventName === "turn.completed" || eventName === "done") {
    return { raw: { event: eventName, payload }, kind: "other", seq };
  }
  return null;
}

function isToolStarted(payload: any): boolean {
  return payload?.event === "item.started" && !!payload?.payload?.tool;
}

function isToolCompleted(payload: any): boolean {
  const kind = payload?.payload?.item?.kind;
  return (
    (payload?.event === "item.completed" || payload?.event === "item.failed") &&
    (kind === "tool_call" || kind === "file_change" || kind === "command_execution")
  );
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
  if (eventName === "turn.completed") {
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
    handle.child.kill("SIGTERM");
  } catch {
    // no-op
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
