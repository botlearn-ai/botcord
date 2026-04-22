export interface StreamBlock {
  /** Raw JSON object as emitted by the underlying CLI (e.g. claude-code stream-json). */
  raw: unknown;
  /** Normalized kind, used to decide whether to forward as stream_block. */
  kind: "assistant_text" | "tool_use" | "tool_result" | "system" | "other";
  /** Sequence number within this turn, starting at 1. */
  seq: number;
}

export interface AdapterRunOptions {
  text: string;
  /** Adapter-native session id for resume; null/empty for a new session. */
  sessionId: string | null;
  cwd: string;
  signal: AbortSignal;
  extraArgs?: string[];
  /** Called for every parsed block while the turn is in progress. */
  onBlock?: (block: StreamBlock) => void;
}

export interface AdapterRunResult {
  /** Final assistant text for this turn (concatenated if streamed). */
  text: string;
  /** Backend session id to persist so the next turn can --resume. */
  newSessionId: string;
  /** Optional cost in USD, if the backend reports it. */
  costUsd?: number;
  /** True if the backend reported a hard error. */
  error?: string;
}

export interface AgentBackend {
  readonly name: "claude-code" | "codex" | "gemini";
  run(opts: AdapterRunOptions): Promise<AdapterRunResult>;
}
