import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  readCommandVersion,
  resolveCommandOnPath,
  type ProbeDeps,
} from "./probe.js";
import { consoleLogger } from "../log.js";
import type {
  RuntimeAdapter,
  RuntimeProbeResult,
  RuntimeRunOptions,
  RuntimeRunResult,
  StreamBlock,
} from "../types.js";

const log = consoleLogger;

const ACP_PROTOCOL_VERSION = 1;
/** How long an idle (no in-flight prompt) ACP child process is kept alive. */
const ACP_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
/** Cap for streamed assistant text per turn. */
const ASSISTANT_TEXT_CAP = 1 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Module-level process pool — survives across adapter instances. The
// dispatcher creates a new `OpenclawAcpAdapter` per turn (see
// `runtimeFactory`), so adapter-instance state cannot hold a long-lived child.
// Pool key includes accountId so different daemon agents never share an ACP
// child even when they target the same gateway profile.
// ---------------------------------------------------------------------------

interface AcpProcessHandle {
  child: ChildProcessWithoutNullStreams;
  /** Pending JSON-RPC requests keyed by id. */
  pending: Map<number, PendingCall>;
  /** Per-ACP-sessionId notification subscribers. */
  subscribers: Map<string, (note: AcpNotification) => void>;
  nextId: number;
  buffer: string;
  initialized: boolean;
  initializePromise?: Promise<void>;
  idleTimer?: NodeJS.Timeout;
  inFlight: number;
  closed: boolean;
  exitReason?: string;
  /**
   * URL + token the child was spawned with. We compare against the live
   * `route.gateway` on every `acquireHandle` so a config-reload/token-rotation
   * under the same gateway name doesn't keep using a stale child.
   */
  spawnedUrl: string;
  spawnedToken: string | undefined;
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  method: string;
}

interface AcpNotification {
  method: string;
  params: any;
}

const ACP_POOL = new Map<string, AcpProcessHandle>();

function poolKey(accountId: string, gatewayName: string): string {
  return `${accountId}::${gatewayName}`;
}

function resetIdle(h: AcpProcessHandle, key: string): void {
  if (h.idleTimer) clearTimeout(h.idleTimer);
  if (h.inFlight > 0) return;
  h.idleTimer = setTimeout(() => {
    if (h.inFlight === 0 && !h.closed) {
      log.info("openclaw-acp.idle-timeout", { key });
      shutdownHandle(h, "idle-timeout");
      ACP_POOL.delete(key);
    }
  }, ACP_IDLE_TIMEOUT_MS);
  h.idleTimer.unref?.();
}

function shutdownHandle(h: AcpProcessHandle, reason: string): void {
  if (h.closed) return;
  h.closed = true;
  h.exitReason = reason;
  if (h.idleTimer) clearTimeout(h.idleTimer);
  for (const p of h.pending.values()) {
    p.reject(new Error(`openclaw acp child closed: ${reason}`));
  }
  h.pending.clear();
  h.subscribers.clear();
  try {
    h.child.kill("SIGTERM");
  } catch {
    // already dead
  }
}

/** Test-only: drop all cached child processes. */
export function __resetOpenclawAcpPoolForTests(): void {
  for (const [key, h] of ACP_POOL.entries()) {
    shutdownHandle(h, "test-reset");
    ACP_POOL.delete(key);
  }
}

// ---------------------------------------------------------------------------
// Probe
// ---------------------------------------------------------------------------

function resolveOpenclawCommand(deps: ProbeDeps = {}): string | null {
  const explicit = (deps.env ?? process.env).BOTCORD_OPENCLAW_BIN;
  if (explicit && explicit.length > 0) return explicit;
  return resolveCommandOnPath("openclaw", deps);
}

export function probeOpenclaw(deps: ProbeDeps = {}): RuntimeProbeResult {
  const command = resolveOpenclawCommand(deps);
  if (!command) return { available: false };
  return {
    available: true,
    path: command,
    version: readCommandVersion(command, [], deps) ?? undefined,
  };
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

interface SpawnDeps {
  spawnFn?: typeof spawn;
}

/**
 * OpenClaw ACP runtime adapter.
 *
 * Spawns `openclaw acp --url <gateway> [--token <token>]` per
 * `(accountId, gatewayName)` pair and reuses the process across turns. The
 * child speaks JSON-RPC over stdio; we send `initialize` once, then
 * `newSession` (with `_meta.sessionKey`) when the daemon has no persisted
 * runtime session id, and `prompt` for each turn. Streaming `session/update`
 * notifications are relayed to `onBlock`.
 *
 * Process-pool lifetime + abort/cancel semantics live at module scope; see
 * `ACP_POOL` and `shutdownHandle` above.
 */
export class OpenclawAcpAdapter implements RuntimeAdapter {
  readonly id = "openclaw-acp" as const;

  private readonly spawnFn: typeof spawn;

  constructor(deps: SpawnDeps = {}) {
    this.spawnFn = deps.spawnFn ?? spawn;
  }

  probe(): RuntimeProbeResult {
    return probeOpenclaw();
  }

  async run(opts: RuntimeRunOptions): Promise<RuntimeRunResult> {
    const gateway = opts.gateway;
    if (!gateway) {
      return failResult(
        opts.sessionId ?? "",
        "openclaw-acp: missing gateway endpoint (route.gateway not resolved)",
      );
    }
    const openclawAgent = gateway.openclawAgent ?? "default";
    const sessionKey = buildAcpSessionKey({
      openclawAgent,
      accountId: opts.accountId,
      // The dispatcher passes `context.conversationKey` in for routing;
      // fall back to a stable per-accountId key when it's not present (e.g.
      // synthetic test calls).
      conversationKey: stringField(opts.context, "conversationKey") ?? "default",
    });

    const key = poolKey(opts.accountId, gateway.name);
    let handle: AcpProcessHandle;
    try {
      handle = await this.acquireHandle(key, opts, gateway);
    } catch (err) {
      return failResult(opts.sessionId ?? "", `openclaw-acp: ${(err as Error).message}`);
    }

    handle.inFlight += 1;
    if (handle.idleTimer) clearTimeout(handle.idleTimer);

    let acpSessionId = opts.sessionId ?? "";
    let seq = 0;
    let assistantText = "";
    let assistantBytes = 0;
    let capped = false;
    let finalText = "";

    const emitBlock = (block: StreamBlock): void => {
      try {
        opts.onBlock?.(block);
      } catch (err) {
        log.warn("openclaw-acp.onBlock-threw", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    };

    const onNotification = (note: AcpNotification): void => {
      seq += 1;
      // Forward raw notification as a stream block for downstream visibility.
      const kind = classifyAcpUpdate(note);
      emitBlock({ raw: note, kind, seq });

      const update = note.params?.update;
      if (update?.sessionUpdate === "agent_message_chunk") {
        const text = extractText(update.content);
        if (text && !capped) {
          const bytes = Buffer.byteLength(text, "utf8");
          if (assistantBytes + bytes > ASSISTANT_TEXT_CAP) {
            capped = true;
          } else {
            assistantText += text;
            assistantBytes += bytes;
          }
        }
      }
    };

    let abortListener: (() => void) | undefined;
    try {
      // Ensure we have an ACP session id. When the dispatcher doesn't carry
      // one, ask the child to create or rebind one for our sessionKey.
      if (!acpSessionId) {
        try {
          acpSessionId = await this.newSession(handle, {
            cwd: opts.cwd,
            sessionKey,
          });
        } catch (err) {
          throw new Error(`newSession failed: ${(err as Error).message}`);
        }
      }
      handle.subscribers.set(acpSessionId, onNotification);

      if (opts.signal?.aborted) {
        return failResult(acpSessionId, "openclaw-acp: aborted before prompt");
      }

      abortListener = () => {
        // Best-effort cancel; ACP `cancel` is a notification (fire-and-forget).
        sendNotification(handle, "session/cancel", { sessionId: acpSessionId });
      };
      opts.signal?.addEventListener("abort", abortListener);

      let promptResult: any;
      try {
        promptResult = await this.prompt(handle, {
          sessionId: acpSessionId,
          text: opts.text,
        });
      } catch (err) {
        const msg = (err as Error).message ?? "prompt failed";
        // If the child says the session is gone (process restart, GC),
        // recreate it so the next turn doesn't hard-fail.
        if (/session not found|unknown session/i.test(msg)) {
          try {
            const fresh = await this.newSession(handle, {
              cwd: opts.cwd,
              sessionKey,
            });
            handle.subscribers.delete(acpSessionId);
            acpSessionId = fresh;
            handle.subscribers.set(acpSessionId, onNotification);
            promptResult = await this.prompt(handle, {
              sessionId: acpSessionId,
              text: opts.text,
            });
          } catch (err2) {
            throw new Error(`prompt failed after session reset: ${(err2 as Error).message}`);
          }
        } else {
          throw err;
        }
      }

      // OpenClaw's prompt response shape isn't strictly fixed; pull a final
      // text out of common locations and otherwise fall back to the streamed
      // chunks accumulated above.
      finalText = pickFinalText(promptResult) ?? assistantText;

      if (capped) {
        log.warn("openclaw-acp.assistant-text-capped", { sessionId: acpSessionId });
      }

      return {
        text: finalText,
        newSessionId: acpSessionId,
      };
    } catch (err) {
      return failResult(acpSessionId, `openclaw-acp: ${(err as Error).message}`);
    } finally {
      if (abortListener && opts.signal) {
        try {
          opts.signal.removeEventListener("abort", abortListener);
        } catch {
          // ignore
        }
      }
      handle.subscribers.delete(acpSessionId);
      handle.inFlight = Math.max(0, handle.inFlight - 1);
      resetIdle(handle, key);
    }
  }

  // ---------------------------------------------------------------------
  // Process management
  // ---------------------------------------------------------------------

  private async acquireHandle(
    key: string,
    opts: RuntimeRunOptions,
    gateway: NonNullable<RuntimeRunOptions["gateway"]>,
  ): Promise<AcpProcessHandle> {
    let handle = ACP_POOL.get(key);
    if (handle && handle.closed) {
      ACP_POOL.delete(key);
      handle = undefined;
    }
    // Invalidate the cached child if its spawn args drifted from the live
    // gateway endpoint — config reload / token rotation under the same
    // profile name must not keep talking to the old --url / --token.
    if (
      handle &&
      (handle.spawnedUrl !== gateway.url || handle.spawnedToken !== gateway.token)
    ) {
      log.info("openclaw-acp.gateway-args-changed", {
        key,
        oldUrl: handle.spawnedUrl,
        newUrl: gateway.url,
        tokenChanged: handle.spawnedToken !== gateway.token,
      });
      shutdownHandle(handle, "gateway-args-changed");
      ACP_POOL.delete(key);
      handle = undefined;
    }
    if (!handle) {
      handle = this.spawnAcpProcess(key, gateway);
      ACP_POOL.set(key, handle);
    }
    if (!handle.initialized) {
      if (!handle.initializePromise) {
        handle.initializePromise = sendRequest(handle, "initialize", {
          protocolVersion: ACP_PROTOCOL_VERSION,
          clientCapabilities: {},
        }).then(() => {
          handle!.initialized = true;
        });
      }
      await handle.initializePromise;
    }
    return handle;
  }

  private spawnAcpProcess(
    key: string,
    gateway: NonNullable<RuntimeRunOptions["gateway"]>,
  ): AcpProcessHandle {
    const command = resolveOpenclawCommand() ?? "openclaw";
    const args = ["acp", "--url", gateway.url];
    if (gateway.token) args.push("--token", gateway.token);

    const child = this.spawnFn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    }) as ChildProcessWithoutNullStreams;

    const handle: AcpProcessHandle = {
      child,
      pending: new Map(),
      subscribers: new Map(),
      nextId: 1,
      buffer: "",
      initialized: false,
      inFlight: 0,
      closed: false,
      spawnedUrl: gateway.url,
      spawnedToken: gateway.token,
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => onStdoutChunk(handle, chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      log.debug("openclaw-acp.stderr", { key, chunk: chunk.slice(0, 500) });
    });
    child.on("exit", (code, signal) => {
      shutdownHandle(handle, `exit code=${code ?? "null"} signal=${signal ?? "null"}`);
      ACP_POOL.delete(key);
    });
    child.on("error", (err) => {
      log.warn("openclaw-acp.child-error", {
        key,
        error: err instanceof Error ? err.message : String(err),
      });
      shutdownHandle(handle, `error: ${(err as Error).message}`);
      ACP_POOL.delete(key);
    });

    return handle;
  }

  private async newSession(
    handle: AcpProcessHandle,
    args: { cwd: string; sessionKey: string },
  ): Promise<string> {
    const result = (await sendRequest(handle, "session/new", {
      cwd: args.cwd,
      mcpServers: [],
      _meta: { sessionKey: args.sessionKey },
    })) as { sessionId?: string };
    if (!result?.sessionId || typeof result.sessionId !== "string") {
      throw new Error("newSession returned no sessionId");
    }
    return result.sessionId;
  }

  private async prompt(
    handle: AcpProcessHandle,
    args: { sessionId: string; text: string },
  ): Promise<any> {
    return sendRequest(handle, "session/prompt", {
      sessionId: args.sessionId,
      prompt: [{ type: "text", text: args.text }],
    });
  }
}

// ---------------------------------------------------------------------------
// JSON-RPC stdio plumbing
// ---------------------------------------------------------------------------

function onStdoutChunk(handle: AcpProcessHandle, chunk: string): void {
  handle.buffer += chunk;
  let idx: number;
  while ((idx = handle.buffer.indexOf("\n")) !== -1) {
    const line = handle.buffer.slice(0, idx).trim();
    handle.buffer = handle.buffer.slice(idx + 1);
    if (!line) continue;
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch (err) {
      log.warn("openclaw-acp.parse-error", {
        error: err instanceof Error ? err.message : String(err),
        line: line.slice(0, 200),
      });
      continue;
    }
    routeMessage(handle, msg);
  }
}

function routeMessage(handle: AcpProcessHandle, msg: any): void {
  if (msg && typeof msg === "object" && "id" in msg && ("result" in msg || "error" in msg)) {
    const id = typeof msg.id === "number" ? msg.id : Number(msg.id);
    const pending = handle.pending.get(id);
    if (!pending) return;
    handle.pending.delete(id);
    if (msg.error) {
      const message = typeof msg.error?.message === "string" ? msg.error.message : "rpc error";
      pending.reject(new Error(message));
    } else {
      pending.resolve(msg.result);
    }
    return;
  }
  // Notification.
  if (msg?.method && msg?.params) {
    const sid = msg.params?.sessionId;
    if (typeof sid === "string") {
      const sub = handle.subscribers.get(sid);
      if (sub) {
        try {
          sub({ method: msg.method, params: msg.params });
        } catch (err) {
          log.warn("openclaw-acp.subscriber-threw", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
  }
}

function sendRequest(
  handle: AcpProcessHandle,
  method: string,
  params: any,
): Promise<unknown> {
  if (handle.closed) return Promise.reject(new Error("acp child closed"));
  return new Promise((resolve, reject) => {
    const id = handle.nextId++;
    handle.pending.set(id, { resolve, reject, method });
    const frame = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
    try {
      handle.child.stdin.write(frame);
    } catch (err) {
      handle.pending.delete(id);
      reject(err as Error);
    }
  });
}

function sendNotification(
  handle: AcpProcessHandle,
  method: string,
  params: any,
): void {
  if (handle.closed) return;
  const frame = JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n";
  try {
    handle.child.stdin.write(frame);
  } catch {
    // best-effort fire-and-forget
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function failResult(sessionId: string, error: string): RuntimeRunResult {
  return {
    text: "",
    newSessionId: sessionId,
    error,
  };
}

function classifyAcpUpdate(note: AcpNotification): StreamBlock["kind"] {
  const update = note.params?.update;
  const kind: string | undefined = update?.sessionUpdate;
  switch (kind) {
    case "agent_message_chunk":
      return "assistant_text";
    case "tool_call":
      return "tool_use";
    case "tool_call_update":
      return "tool_result";
    case "session_info_update":
    case "available_commands_update":
    case "usage_update":
      return "system";
    default:
      return "other";
  }
}

function extractText(content: unknown): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map(extractText).join("");
  }
  if (typeof content === "object") {
    const c = content as Record<string, unknown>;
    if (typeof c.text === "string") return c.text;
    if (typeof c.content === "string") return c.content;
    if (Array.isArray(c.content)) return extractText(c.content);
  }
  return "";
}

function pickFinalText(result: unknown): string | undefined {
  if (!result || typeof result !== "object") return undefined;
  const r = result as Record<string, unknown>;
  if (typeof r.text === "string" && r.text.length > 0) return r.text;
  if (typeof r.message === "string" && r.message.length > 0) return r.message;
  return undefined;
}

function stringField(bag: Record<string, unknown> | undefined, key: string): string | undefined {
  if (!bag) return undefined;
  const v = bag[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/**
 * Build the OpenClaw ACP `sessionKey` for a daemon turn. `accountId` is
 * always included to prevent two daemon agents from colliding on the same
 * gateway-side key (RFC §3.5.2 串号 防御).
 */
export function buildAcpSessionKey(args: {
  openclawAgent: string;
  accountId: string;
  conversationKey: string;
}): string {
  return `agent:${args.openclawAgent}:${args.accountId}:${args.conversationKey}`;
}
