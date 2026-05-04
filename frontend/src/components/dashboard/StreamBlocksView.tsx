"use client";

import { useState, useEffect, useRef } from "react";
import { Search, FileText, CheckCircle2, Code2, Brain, HelpCircle, Wrench, ChevronDown, ChevronRight, Bot, AlertTriangle, ListTodo, Info } from "lucide-react";
import type { StreamBlockEntry } from "@/lib/types";
import MarkdownContent from "@/components/ui/MarkdownContent";
import ToolResultContent from "./ToolResultContent";

/** Icon for a tool_call based on tool name heuristics. */
function ToolCallIcon({ name }: { name: string }) {
  const n = name.toLowerCase();
  if (n.includes("search") || n.includes("find") || n.includes("query")) {
    return <Search className="w-3 h-3 text-cyan-400 shrink-0" />;
  }
  if (n.includes("read") || n.includes("get") || n.includes("fetch") || n.includes("list")) {
    return <FileText className="w-3 h-3 text-cyan-400 shrink-0" />;
  }
  return <Code2 className="w-3 h-3 text-cyan-400 shrink-0" />;
}

function summarizeParams(params: Record<string, unknown> | undefined): string | null {
  if (!params || Object.keys(params).length === 0) return null;
  for (const v of Object.values(params)) {
    if (typeof v === "string" && v.length > 0) {
      return v.length > 60 ? v.slice(0, 60) + "..." : v;
    }
  }
  return null;
}

function summarizeResult(result: string): string {
  if (result.startsWith("{") || result.startsWith("[")) {
    try {
      const parsed = JSON.parse(result);
      if (parsed?.content?.[0]?.text) {
        const text = parsed.content[0].text as string;
        return text.length > 120 ? text.slice(0, 120) + "..." : text;
      }
    } catch { /* not valid JSON, use raw */ }
  }
  return result.length > 120 ? result.slice(0, 120) + "..." : result;
}

/** Normalize a stream block into a displayable view-model, handling both the
 *  legacy plugin shape (`payload`) and the daemon-gateway shape (`raw`). */
interface BlockView {
  kind: "tool_call" | "tool_result" | "reasoning" | "system" | "error" | "todo" | "unknown";
  toolName?: string;
  paramHint?: string | null;
  resultStr?: string;
  reasoningText?: string;
  systemLabel?: string;
  systemDetails?: string;
  errorText?: string;
  todoItems?: Array<{ text: string; status?: string }>;
  rawKind: string;
}

function stringifyDetails(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function extractContentText(content: unknown): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map(extractContentText).filter(Boolean).join("\n");
  }
  if (typeof content === "object") {
    const c = content as any;
    if (typeof c.text === "string") return c.text;
    if (typeof c.thinking === "string") return c.thinking;
    if (typeof c.content === "string") return c.content;
    if (Array.isArray(c.content)) return extractContentText(c.content);
  }
  return "";
}

function blockDetails(raw: unknown, payload?: Record<string, unknown>): string {
  const payloadDetails = stringifyDetails(payload?.details);
  if (payloadDetails) return payloadDetails;
  const rawAny = raw as any;
  const direct =
    typeof rawAny?.text === "string" ? rawAny.text
    : typeof rawAny?.message === "string" ? rawAny.message
    : typeof rawAny?.summary === "string" ? rawAny.summary
    : "";
  if (direct) return direct;
  const contentText = extractContentText(rawAny?.content ?? rawAny?.message?.content ?? rawAny?.params?.update?.content);
  if (contentText) return contentText;
  return raw ? stringifyDetails(raw) : payload ? stringifyDetails(payload) : "";
}

/** Build a `tool_use_id → name` map by walking all blocks. Claude-code's
 *  tool_result entries reference the originating tool only by `tool_use_id`,
 *  so we need the matching tool_use block to recover the human name. */
function buildToolNameById(blocks: StreamBlockEntry[]): Record<string, string> {
  const m: Record<string, string> = {};
  for (const b of blocks) {
    const contents = (b.block.raw as any)?.message?.content;
    if (!Array.isArray(contents)) continue;
    for (const c of contents) {
      if (c?.type === "tool_use" && typeof c.id === "string" && typeof c.name === "string") {
        m[c.id] = c.name;
      }
    }
  }
  return m;
}

function normalizeBlock(
  block: StreamBlockEntry["block"],
  ctx?: { toolNameById?: Record<string, string> },
): BlockView {
  const { kind, payload, raw } = block;
  const rawAny = raw as any;

  // Legacy shape ------------------------------------------------------------
  if (kind === "tool_call") {
    return {
      kind: "tool_call",
      toolName: (payload?.name as string) || "tool",
      paramHint: summarizeParams(payload?.params as Record<string, unknown> | undefined),
      rawKind: kind,
    };
  }
  if (kind === "tool_result" && payload) {
    return {
      kind: "tool_result",
      toolName: (payload.name as string) || "tool",
      resultStr: String(payload.result ?? ""),
      rawKind: kind,
    };
  }
  if (kind === "reasoning") {
    return {
      kind: "reasoning",
      reasoningText: (payload?.text as string) || blockDetails(raw, payload),
      rawKind: kind,
    };
  }
  if (kind === "thinking") {
    const phase = typeof payload?.phase === "string" ? payload.phase : undefined;
    const label = typeof payload?.label === "string" ? payload.label : undefined;
    return {
      kind: "reasoning",
      reasoningText: blockDetails(raw, payload),
      rawKind: label || (phase ? `thinking: ${phase}` : "thinking"),
    };
  }

  // Daemon-gateway shape (Codex / Claude-code) ------------------------------
  if (kind === "tool_use") {
    // Claude-code: raw.message.content[*] where type === "tool_use"
    const contents = rawAny?.message?.content;
    if (Array.isArray(contents)) {
      const tu = contents.find((c: any) => c?.type === "tool_use");
      if (tu) {
        return {
          kind: "tool_call",
          toolName: (tu.name as string) || "tool",
          paramHint: summarizeParams((tu.input || tu.arguments) as Record<string, unknown> | undefined),
          rawKind: kind,
        };
      }
    }
    // Codex: raw.item.type is the concrete tool kind
    const item = rawAny?.item;
    if (item) {
      const name = (item.type as string) || "tool";
      const hint =
        typeof item.command === "string" ? item.command
        : typeof item.path === "string" ? item.path
        : typeof item.query === "string" ? item.query
        : summarizeParams(item as Record<string, unknown>);
      return {
        kind: "tool_call",
        toolName: name,
        paramHint: typeof hint === "string" && hint.length > 60 ? hint.slice(0, 60) + "..." : hint ?? null,
        rawKind: kind,
      };
    }
    return { kind: "tool_call", toolName: "tool", rawKind: kind };
  }

  if (kind === "tool_result") {
    // Claude-code: raw.message.content[*] where type === "tool_result".
    // The tool name is not on the result itself — look it up via tool_use_id.
    const contents = rawAny?.message?.content;
    if (Array.isArray(contents)) {
      const tr = contents.find((c: any) => c?.type === "tool_result");
      if (tr) {
        const content = tr.content;
        let resultStr = "";
        if (typeof content === "string") resultStr = content;
        else if (Array.isArray(content)) {
          resultStr = content.map((c: any) => c?.text ?? "").filter(Boolean).join("\n");
        }
        const id = typeof tr.tool_use_id === "string" ? tr.tool_use_id : undefined;
        const name = (id && ctx?.toolNameById?.[id]) || "tool";
        return {
          kind: "tool_result",
          toolName: name,
          resultStr,
          rawKind: kind,
        };
      }
    }
    return { kind: "tool_result", toolName: "tool", resultStr: "", rawKind: kind };
  }

  if (kind === "system") {
    // Codex thread.started / turn.started / turn.completed; Claude-code system init.
    const type = rawAny?.type as string | undefined;
    const subtype = rawAny?.subtype as string | undefined;
    const payloadSubtype = payload?.subtype as string | undefined;
    const turnStatus = rawAny?.turn?.status as string | undefined;
    let label = type || "system";
    if (type === "system" && subtype) label = `system: ${subtype}`;
    else if (!type && payloadSubtype) label = `system: ${payloadSubtype}`;
    else if (type === "turn.completed" && turnStatus) label = `turn ${turnStatus}`;
    return { kind: "system", systemLabel: label, systemDetails: blockDetails(raw, payload), rawKind: label };
  }

  // `other` — try to extract something useful from the raw event so users
  // see more than the literal "other" label.
  if (kind === "other") {
    const type: string | undefined = rawAny?.type;
    const item = rawAny?.item;
    const itemType: string | undefined = item?.type;

    // Codex reasoning summary
    if (itemType === "reasoning") {
      const text =
        (typeof item.text === "string" && item.text) ||
        (typeof item.summary === "string" && item.summary) ||
        (Array.isArray(item.summary)
          ? item.summary.map((s: any) => s?.text ?? "").filter(Boolean).join("\n")
          : "");
      if (text) {
        return { kind: "reasoning", reasoningText: text, rawKind: "reasoning" };
      }
    }

    // Codex todo list updates
    if (itemType === "todo_list") {
      const items = Array.isArray(item.items)
        ? item.items.map((t: any) => ({
            text: typeof t?.text === "string" ? t.text : String(t),
            status: typeof t?.status === "string" ? t.status : undefined,
          }))
        : [];
      return { kind: "todo", todoItems: items, rawKind: "todo_list" };
    }

    // Codex error / Claude-code error events
    if (type === "error") {
      const err = rawAny?.error;
      const msg = typeof err === "string" ? err : err?.message;
      return { kind: "error", errorText: msg || "error", rawKind: "error" };
    }

    // Claude-code final result event
    if (type === "result") {
      const subtype = rawAny?.subtype as string | undefined;
      const label = subtype ? `result: ${subtype}` : "result";
      return { kind: "system", systemLabel: label, rawKind: label };
    }

    // Generic: surface a readable label instead of literal "other".
    const label =
      itemType ? `${type ?? "item"}.${itemType}`
      : type ?? "other";
    return { kind: "unknown", rawKind: label };
  }

  return { kind: "unknown", rawKind: kind };
}

function StreamBlockItem({
  block,
  toolNameById,
}: {
  block: StreamBlockEntry;
  toolNameById?: Record<string, string>;
}) {
  const view = normalizeBlock(block.block, { toolNameById });
  const [resultExpanded, setResultExpanded] = useState(false);

  if (view.kind === "tool_call") {
    const name = view.toolName || "tool";
    return (
      <div className="flex items-start gap-2 py-1">
        <ToolCallIcon name={name} />
        <div className="min-w-0">
          <span className="text-xs font-mono text-cyan-400">{name}</span>
          {view.paramHint && (
            <p className="text-[10px] text-zinc-500 truncate mt-0.5">{view.paramHint}</p>
          )}
        </div>
      </div>
    );
  }

  if (view.kind === "tool_result") {
    const name = view.toolName || "tool";
    const resultStr = view.resultStr || "";
    return (
      <div className="py-1">
        <button
          onClick={() => resultStr && setResultExpanded(!resultExpanded)}
          className="flex items-center gap-2 group"
        >
          <CheckCircle2 className="w-3 h-3 text-emerald-400 shrink-0" />
          <span className="text-xs font-mono text-emerald-400">{name}</span>
          <span className="text-[10px] text-zinc-500">returned</span>
          {resultStr && (
            resultExpanded
              ? <ChevronDown className="w-2.5 h-2.5 text-zinc-500" />
              : <ChevronRight className="w-2.5 h-2.5 text-zinc-500" />
          )}
        </button>
        {resultStr && !resultExpanded && (
          <p className="mt-0.5 ml-5 text-[10px] text-zinc-500 truncate max-w-[400px]">
            {summarizeResult(resultStr)}
          </p>
        )}
        {resultStr && resultExpanded && (
          <ToolResultContent result={resultStr} toolName={name} />
        )}
      </div>
    );
  }

  if (view.kind === "reasoning") {
    const text = view.reasoningText || "";
    return (
      <div className="py-1">
        <button
          onClick={() => text && setResultExpanded(!resultExpanded)}
          className="flex items-center gap-2 group"
        >
          <Brain className="w-3 h-3 text-purple-400 shrink-0" />
          <span className="text-xs font-mono text-purple-300/80">{view.rawKind || "thinking"}</span>
          {text && (
            resultExpanded
              ? <ChevronDown className="w-2.5 h-2.5 text-zinc-500" />
              : <ChevronRight className="w-2.5 h-2.5 text-zinc-500" />
          )}
        </button>
        {text && !resultExpanded && (
          <p className="mt-0.5 ml-5 text-[10px] text-purple-300/60 italic leading-relaxed line-clamp-2">
            {summarizeResult(text)}
          </p>
        )}
        {text && resultExpanded && (
          <ToolResultContent result={text} toolName={view.rawKind || "thinking"} />
        )}
      </div>
    );
  }

  if (view.kind === "error") {
    return (
      <div className="flex items-start gap-2 py-1">
        <AlertTriangle className="w-3 h-3 text-red-400 shrink-0 mt-0.5" />
        <p className="text-xs text-red-300/80 leading-relaxed line-clamp-3">
          {view.errorText || "error"}
        </p>
      </div>
    );
  }

  if (view.kind === "todo") {
    const items = view.todoItems ?? [];
    return (
      <div className="py-1">
        <div className="flex items-center gap-2">
          <ListTodo className="w-3 h-3 text-amber-400 shrink-0" />
          <span className="text-xs font-mono text-amber-400">todo_list</span>
          {items.length > 0 && (
            <span className="text-[10px] text-zinc-500">{items.length} item{items.length !== 1 ? "s" : ""}</span>
          )}
        </div>
        {items.length > 0 && (
          <ul className="mt-0.5 ml-5 space-y-0.5">
            {items.slice(0, 6).map((it, idx) => (
              <li key={idx} className="text-[10px] text-zinc-400 truncate">
                <span className="text-zinc-600 mr-1">
                  {it.status === "completed" ? "✓" : it.status === "in_progress" ? "→" : "○"}
                </span>
                {it.text}
              </li>
            ))}
            {items.length > 6 && (
              <li className="text-[10px] text-zinc-600">… {items.length - 6} more</li>
            )}
          </ul>
        )}
      </div>
    );
  }

  if (view.kind === "system") {
    const details = view.systemDetails || "";
    return (
      <div className="py-1">
        <button
          onClick={() => details && setResultExpanded(!resultExpanded)}
          className="flex items-center gap-2 group"
        >
          <Info className="w-3 h-3 text-zinc-500 shrink-0" />
          <span className="text-xs text-zinc-500 font-mono">{view.systemLabel || view.rawKind}</span>
          {details && (
            resultExpanded
              ? <ChevronDown className="w-2.5 h-2.5 text-zinc-500" />
              : <ChevronRight className="w-2.5 h-2.5 text-zinc-500" />
          )}
        </button>
        {details && !resultExpanded && (
          <p className="mt-0.5 ml-5 text-[10px] text-zinc-500 truncate max-w-[400px]">
            {summarizeResult(details)}
          </p>
        )}
        {details && resultExpanded && (
          <ToolResultContent result={details} toolName={view.systemLabel || view.rawKind} />
        )}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 py-1">
      <HelpCircle className="w-3 h-3 text-zinc-500 shrink-0" />
      <span className="text-xs text-zinc-500 font-mono">{view.rawKind}</span>
    </div>
  );
}

export default function StreamBlocksView({
  blocks,
  defaultExpanded,
  onScrollRequest,
}: {
  blocks: StreamBlockEntry[];
  defaultExpanded?: boolean;
  onScrollRequest?: () => void;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded ?? false);
  const autoCollapsedRef = useRef(false);

  const isAssistant = (k: string) => k === "assistant" || k === "assistant_text";
  const executionBlocks = blocks.filter((b) => !isAssistant(b.block.kind));

  // Build tool_use_id → name map so tool_result rows can show the real tool name.
  const toolNameById = buildToolNameById(blocks);

  const normalized = executionBlocks.map((b) => normalizeBlock(b.block, { toolNameById }).kind);
  const toolCallCount = normalized.filter((k) => k === "tool_call").length;
  const reasoningCount = normalized.filter((k) => k === "reasoning").length;

  /** Compose the streamed prose by walking every block — covers mixed
   *  Claude-code blocks where the daemon labelled the block as `tool_use`
   *  because content[] held both `text` and `tool_use` items. */
  function buildComposingText(): string {
    const parts: string[] = [];
    for (const b of blocks) {
      const k = b.block.kind;
      if (k === "assistant") {
        parts.push((b.block.payload?.text as string) || "");
        continue;
      }
      if (k === "assistant_text" || k === "tool_use") {
        const raw = b.block.raw as any;
        if (k === "assistant_text" && typeof raw?.item?.text === "string") {
          parts.push(raw.item.text);
          continue;
        }
        const contents = raw?.message?.content;
        if (Array.isArray(contents)) {
          for (const c of contents) {
            if (c?.type === "text" && typeof c.text === "string") parts.push(c.text);
          }
        }
      }
    }
    return parts.join("");
  }
  const composingText = buildComposingText();

  useEffect(() => {
    onScrollRequest?.();
  }, [blocks.length, onScrollRequest]);

  useEffect(() => {
    if (composingText && !autoCollapsedRef.current) {
      autoCollapsedRef.current = true;
      setExpanded(false);
    }
  }, [composingText]);

  if (blocks.length === 0) return null;

  const summaryParts: string[] = [];
  if (toolCallCount > 0) summaryParts.push(`${toolCallCount} tool call${toolCallCount !== 1 ? "s" : ""}`);
  if (reasoningCount > 0) summaryParts.push(`${reasoningCount} reasoning`);
  if (summaryParts.length === 0) summaryParts.push(`${executionBlocks.length} step${executionBlocks.length !== 1 ? "s" : ""}`);

  return (
    <div className="flex justify-start">
      <div className="max-w-[85%] space-y-2">
        {executionBlocks.length > 0 && (
          <div className="rounded-lg border border-zinc-700/40 bg-zinc-900/40 overflow-hidden">
            <button
              onClick={() => setExpanded(!expanded)}
              className="flex items-center gap-1.5 w-full px-3 py-1.5 text-xs text-zinc-400 hover:text-zinc-300 transition-colors"
            >
              {expanded ? (
                <ChevronDown className="w-3 h-3" />
              ) : (
                <ChevronRight className="w-3 h-3" />
              )}
              <Wrench className="w-3 h-3" />
              <span>{summaryParts.join(", ")}</span>
            </button>
            {expanded && (
              <div className="border-t border-zinc-800/60 px-3 py-1 divide-y divide-zinc-800/40">
                {executionBlocks.map((block) => (
                  <StreamBlockItem
                    key={`${block.trace_id}-${block.seq}`}
                    block={block}
                    toolNameById={toolNameById}
                  />
                ))}
              </div>
            )}
          </div>
        )}

        {composingText && (
          <div className="rounded-lg px-3 py-2 bg-zinc-800 border border-zinc-700 text-sm text-zinc-200">
            <div className="mb-1 flex items-center gap-1.5">
              <Bot className="w-3 h-3 text-zinc-400" />
              <span className="text-xs text-zinc-400">Composing...</span>
            </div>
            <MarkdownContent content={composingText} />
          </div>
        )}
      </div>
    </div>
  );
}
