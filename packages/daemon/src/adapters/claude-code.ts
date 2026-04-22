import { spawn } from "node:child_process";
import { log } from "../log.js";
import type {
  AdapterRunOptions,
  AdapterRunResult,
  AgentBackend,
  StreamBlock,
} from "./types.js";

/**
 * Claude Code adapter — spawns `claude -p "<text>" --output-format stream-json`
 * (with `--resume <sid>` when available) and parses the ndjson stream.
 *
 * stream-json shape (abridged):
 *   {type:"system", subtype:"init", session_id:"...", ...}
 *   {type:"assistant", message:{content:[{type:"text", text:"..."} | {type:"tool_use", ...}]}}
 *   {type:"user", message:{content:[{type:"tool_result", ...}]}}
 *   {type:"result", subtype:"success", session_id:"...", total_cost_usd: 0.01, result:"final text"}
 */
export class ClaudeCodeAdapter implements AgentBackend {
  readonly name = "claude-code" as const;

  private readonly binary: string;

  constructor(opts?: { binary?: string }) {
    this.binary = opts?.binary ?? process.env.BOTCORD_CLAUDE_BIN ?? "claude";
  }

  async run(opts: AdapterRunOptions): Promise<AdapterRunResult> {
    const args = ["-p", opts.text, "--output-format", "stream-json", "--verbose"];
    if (opts.sessionId) {
      args.push("--resume", opts.sessionId);
    }
    // Default to acceptEdits — owner trusts their own agent. Override via extraArgs.
    if (!opts.extraArgs?.some((a) => a.startsWith("--permission-mode"))) {
      args.push("--permission-mode", "acceptEdits");
    }
    if (opts.extraArgs?.length) args.push(...opts.extraArgs);

    log.debug("claude-code spawn", { cwd: opts.cwd, sessionId: opts.sessionId, argv: args });

    const child = spawn(this.binary, args, {
      cwd: opts.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const onAbort = () => {
      if (!child.killed) child.kill("SIGTERM");
    };
    opts.signal.addEventListener("abort", onAbort, { once: true });

    let seq = 0;
    let finalText = "";
    let newSessionId = opts.sessionId ?? "";
    let costUsd: number | undefined;
    let errorText: string | undefined;
    const assistantTextChunks: string[] = [];

    // Keep stderr bounded — long-running turns with chatty stderr would otherwise grow unbounded.
    const STDERR_CAP = 8 * 1024;
    let stderrTail = "";
    child.stderr?.on("data", (buf) => {
      stderrTail = (stderrTail + String(buf)).slice(-STDERR_CAP);
    });

    let stdoutBuf = "";
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      stdoutBuf += chunk;
      let idx: number;
      while ((idx = stdoutBuf.indexOf("\n")) !== -1) {
        const line = stdoutBuf.slice(0, idx).trim();
        stdoutBuf = stdoutBuf.slice(idx + 1);
        if (!line) continue;
        let obj: any;
        try {
          obj = JSON.parse(line);
        } catch {
          log.warn("claude-code non-json stdout line", { line: line.slice(0, 200) });
          continue;
        }
        const block = normalizeBlock(obj, ++seq);
        opts.onBlock?.(block);

        if (obj.type === "system" && obj.session_id) {
          newSessionId = String(obj.session_id);
        } else if (obj.type === "assistant" && Array.isArray(obj.message?.content)) {
          for (const c of obj.message.content) {
            if (c?.type === "text" && typeof c.text === "string") {
              assistantTextChunks.push(c.text);
            }
          }
        } else if (obj.type === "result") {
          if (typeof obj.session_id === "string") newSessionId = obj.session_id;
          if (typeof obj.total_cost_usd === "number") costUsd = obj.total_cost_usd;
          if (typeof obj.result === "string") finalText = obj.result;
          if (obj.subtype && obj.subtype !== "success" && typeof obj.result === "string") {
            errorText = obj.result;
          }
        }
      }
    });

    const code: number = await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (c) => resolve(c ?? 0));
    });
    opts.signal.removeEventListener("abort", onAbort);

    if (code !== 0 && !errorText) {
      errorText = `claude exited with code ${code}: ${stderrTail.slice(-500)}`;
    }

    const text = finalText || assistantTextChunks.join("").trim();

    return {
      text,
      newSessionId,
      costUsd,
      ...(errorText ? { error: errorText } : {}),
    };
  }
}

function normalizeBlock(obj: any, seq: number): StreamBlock {
  let kind: StreamBlock["kind"] = "other";
  if (obj?.type === "assistant") {
    const contents = Array.isArray(obj.message?.content) ? obj.message.content : [];
    if (contents.some((c: any) => c?.type === "tool_use")) kind = "tool_use";
    else if (contents.some((c: any) => c?.type === "text")) kind = "assistant_text";
  } else if (obj?.type === "user") {
    const contents = Array.isArray(obj.message?.content) ? obj.message.content : [];
    if (contents.some((c: any) => c?.type === "tool_result")) kind = "tool_result";
  } else if (obj?.type === "system") {
    kind = "system";
  }
  return { raw: obj, kind, seq };
}
