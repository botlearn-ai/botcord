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
  nonJsonStdoutTail: string[];
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
 * child speaks JSON-RPC over stdio; we send `initialize` once, then derive a
 * stable OpenClaw `sessionKey` for the BotCord conversation. The persisted
 * `runtimeSessionId` is only an ACP transport handle cached from a previous
 * turn, so every resume first goes through `session/load` with
 * `_meta.sessionKey` before `prompt`. Streaming `session/update`
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

    // ACP session ids are process-local transport handles. They are useful as
    // a cache, but the stable conversation identity is `sessionKey`.
    let acpSessionId = opts.sessionId ?? "";
    let seq = 0;
    let assistantText = "";
    let assistantBytes = 0;
    let capped = false;
    let finalText = "";
    const assistantTextFilter = createAssistantTextFilter();

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
      const update = note.params?.update;
      if (update?.sessionUpdate === "agent_message_chunk") {
        const text = assistantTextFilter.push(extractText(update.content));
        if (text && !capped) {
          const bytes = Buffer.byteLength(text, "utf8");
          if (assistantBytes + bytes > ASSISTANT_TEXT_CAP) {
            capped = true;
          } else {
            assistantText += text;
            assistantBytes += bytes;
          }
        }
        if (!text) return;
        seq += 1;
        emitBlock({ raw: sanitizeAssistantChunk(note, text), kind: "assistant_text", seq });
        return;
      }

      seq += 1;
      // Forward raw non-assistant notifications as stream blocks for downstream visibility.
      const kind = classifyAcpUpdate(note);
      emitBlock({ raw: note, kind, seq });
    };

    let abortListener: (() => void) | undefined;
    try {
      // Ensure we have a live ACP transport session. If the dispatcher passes a
      // cached session id, ask OpenClaw to load/rebind it with the stable
      // sessionKey. If that handle is gone, discard it and create a fresh one.
      if (acpSessionId) {
        try {
          acpSessionId = await this.loadSession(handle, {
            sessionId: acpSessionId,
            cwd: opts.cwd,
            sessionKey,
          });
        } catch (err) {
          if (!isSessionNotFoundError(err)) throw err;
          log.warn("openclaw-acp.session-load-not-found", {
            accountId: opts.accountId,
            oldSessionId: acpSessionId,
            sessionKey,
          });
          acpSessionId = "";
        }
      }

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
        // If the child says the session is gone (process restart, GC),
        // recreate it so the next turn doesn't hard-fail.
        if (isSessionNotFoundError(err)) {
          try {
            const oldSessionId = acpSessionId;
            log.warn("openclaw-acp.prompt-session-not-found-retry", {
              accountId: opts.accountId,
              oldSessionId,
              sessionKey,
            });
            const fresh = await this.newSession(handle, {
              cwd: opts.cwd,
              sessionKey,
            });
            handle.subscribers.delete(acpSessionId);
            acpSessionId = fresh;
            handle.subscribers.set(acpSessionId, onNotification);
            log.info("openclaw-acp.session-recreated", {
              accountId: opts.accountId,
              oldSessionId,
              newSessionId: acpSessionId,
              sessionKey,
            });
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
      const tailText = assistantTextFilter.flush();
      if (tailText && !capped) {
        const bytes = Buffer.byteLength(tailText, "utf8");
        if (assistantBytes + bytes <= ASSISTANT_TEXT_CAP) {
          assistantText += tailText;
          assistantBytes += bytes;
          seq += 1;
          emitBlock({
            raw: {
              method: "session/update",
              params: {
                sessionId: acpSessionId,
                update: { sessionUpdate: "agent_message_chunk", content: [{ type: "text", text: tailText }] },
              },
            },
            kind: "assistant_text",
            seq,
          });
        }
      }
      const pickedText = normalizeAssistantText(pickFinalText(promptResult));
      const streamedText = normalizeAssistantText(assistantText);
      finalText = pickedText && !looksLikeReasoningLeak(pickedText) ? pickedText : streamedText;

      if (capped) {
        log.warn("openclaw-acp.assistant-text-capped", { sessionId: acpSessionId });
      }

      if (!finalText) {
        const stopReason = pickStopReason(promptResult);
        const warningTail = handle.nonJsonStdoutTail.slice(-8).join("\n").trim();
        const detail = warningTail ? `; stdout: ${truncateDetail(warningTail, 1000)}` : "";
        const reason = stopReason ? `prompt stopped: ${stopReason}` : "empty assistant response";
        return failResult(acpSessionId, `openclaw-acp: ${reason}${detail}`);
      }

      return {
        text: finalText,
        newSessionId: acpSessionId,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return failResult(
        isSessionNotFoundError(err) ? "" : acpSessionId,
        `openclaw-acp: ${message}`,
      );
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
      nonJsonStdoutTail: [],
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

  private async loadSession(
    handle: AcpProcessHandle,
    args: { sessionId: string; cwd: string; sessionKey: string },
  ): Promise<string> {
    const result = (await sendRequest(handle, "session/load", {
      sessionId: args.sessionId,
      cwd: args.cwd,
      mcpServers: [],
      _meta: { sessionKey: args.sessionKey },
    })) as { sessionId?: string } | null;
    if (result?.sessionId && typeof result.sessionId === "string") {
      return result.sessionId;
    }
    return args.sessionId;
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
      handle.nonJsonStdoutTail.push(line.slice(0, 500));
      if (handle.nonJsonStdoutTail.length > 20) {
        handle.nonJsonStdoutTail.splice(0, handle.nonJsonStdoutTail.length - 20);
      }
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
      const message = formatRpcError(msg.error);
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

function formatRpcError(error: unknown): string {
  if (!error || typeof error !== "object") return "rpc error";
  const e = error as Record<string, unknown>;
  const message = typeof e.message === "string" ? e.message : "rpc error";
  const data = e.data;
  if (data && typeof data === "object") {
    const details = (data as Record<string, unknown>).details;
    if (typeof details === "string" && details.length > 0) {
      return `${message}: ${details}`;
    }
  }
  return message;
}

function isSessionNotFoundError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /session(?:\s+[\w-]+)?\s+not\s+found|unknown\s+session/i.test(msg);
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
    const type = typeof c.type === "string" ? c.type.toLowerCase() : "";
    if (type === "thinking" || type === "reasoning" || type === "thought") return "";
    if (typeof c.text === "string") return c.text;
    if (typeof c.content === "string") return c.content;
    if (Array.isArray(c.content)) return extractText(c.content);
  }
  return "";
}

function sanitizeAssistantChunk(note: AcpNotification, text: string): AcpNotification {
  return {
    ...note,
    params: {
      ...note.params,
      update: {
        ...note.params?.update,
        content: [{ type: "text", text }],
      },
    },
  };
}

function normalizeAssistantText(text: string | undefined): string {
  if (!text) return "";
  const finalMatch = text.match(/<final>([\s\S]*?)<\/final>/i);
  const selected = finalMatch ? finalMatch[1] : text;
  if (!finalMatch && selected.trimStart().toLowerCase().startsWith("<think")) {
    return "";
  }
  return selected
    .replace(/<think[^>]*>[\s\S]*?<\/think>/gi, "")
    .replace(/<\/?final>/gi, "")
    .trim();
}

function createAssistantTextFilter(): {
  push(text: string): string;
  flush(): string;
} {
  let pending = "";
  let inThink = false;
  let inFinal = false;
  let seenFinal = false;
  let fallback = "";

  const consume = (flush: boolean): string => {
    let out = "";
    while (pending.length > 0) {
      if (inThink) {
        const close = pending.search(/<\/think>/i);
        if (close === -1) {
          if (flush) pending = "";
          return out;
        }
        pending = pending.slice(close).replace(/^<\/think>/i, "");
        inThink = false;
        continue;
      }
      if (inFinal) {
        const close = pending.search(/<\/final>/i);
        if (close === -1) {
          out += pending;
          pending = "";
          return out;
        }
        out += pending.slice(0, close);
        pending = pending.slice(close).replace(/^<\/final>/i, "");
        inFinal = false;
        continue;
      }

      const lt = pending.indexOf("<");
      if (lt === -1) {
        if (seenFinal) {
          out += pending;
        } else {
          fallback += pending;
        }
        pending = "";
        return out;
      }

      if (lt > 0) {
        if (seenFinal) {
          out += pending.slice(0, lt);
        } else {
          fallback += pending.slice(0, lt);
        }
        pending = pending.slice(lt);
        continue;
      }

      const lower = pending.toLowerCase();
      if (lower.startsWith("<think")) {
        const end = pending.indexOf(">");
        if (end === -1) {
          if (flush) pending = "";
          return out;
        }
        pending = pending.slice(end + 1);
        inThink = true;
        continue;
      }
      if (lower.startsWith("</think")) {
        const end = pending.indexOf(">");
        if (end === -1) {
          if (flush) pending = "";
          return out;
        }
        pending = pending.slice(end + 1);
        continue;
      }
      if (lower.startsWith("<final")) {
        const end = pending.indexOf(">");
        if (end === -1) {
          if (flush) pending = "";
          return out;
        }
        pending = pending.slice(end + 1);
        seenFinal = true;
        fallback = "";
        inFinal = true;
        continue;
      }
      if (lower.startsWith("</final")) {
        const end = pending.indexOf(">");
        if (end === -1) {
          if (flush) pending = "";
          return out;
        }
        pending = pending.slice(end + 1);
        inFinal = false;
        continue;
      }

      const knownPrefixes = ["<think", "</think", "<final", "</final"];
      if (!flush && knownPrefixes.some((prefix) => prefix.startsWith(lower))) {
        return out;
      }

      out += "<";
      pending = pending.slice(1);
    }
    if (flush && !seenFinal && fallback) {
      const text = normalizeAssistantText(fallback);
      fallback = "";
      if (!looksLikeReasoningLeak(text)) return text;
    }
    return out;
  };

  return {
    push(text: string): string {
      if (!text) return "";
      pending += text;
      return consume(false);
    },
    flush(): string {
      return consume(true);
    },
  };
}

function pickFinalText(result: unknown): string | undefined {
  if (!result || typeof result !== "object") return undefined;
  const r = result as Record<string, unknown>;
  if (Array.isArray(r.assistantTexts)) {
    const text = r.assistantTexts.filter((x): x is string => typeof x === "string").join("\n");
    if (text.length > 0) return text;
  }
  const contentText = extractText(r.content);
  if (contentText.length > 0) return contentText;
  const outputText = extractText(r.output);
  if (outputText.length > 0) return outputText;
  const responseText = extractText(r.response);
  if (responseText.length > 0) return responseText;
  if (typeof r.text === "string" && r.text.length > 0) return r.text;
  if (typeof r.message === "string" && r.message.length > 0) return r.message;
  return undefined;
}

function pickStopReason(result: unknown): string | undefined {
  if (!result || typeof result !== "object") return undefined;
  const v = (result as Record<string, unknown>).stopReason;
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function truncateDetail(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function looksLikeReasoningLeak(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  return (
    /^the user (said|asked|wants|is asking)\b/i.test(t) ||
    /^i('|’)m .*\b(i('|’)ll|i will|need to|should|going to)\b/i.test(t) ||
    /\bi('|’)ll respond\b/i.test(t) ||
    /\bi need to\b/i.test(t)
  );
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
