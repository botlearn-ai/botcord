"use client";

import { useState, useEffect } from "react";
import { Search, FileText, CheckCircle2, Code2, Brain, HelpCircle, Wrench, ChevronDown, ChevronRight, Bot } from "lucide-react";
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
  kind: "tool_call" | "tool_result" | "reasoning" | "system" | "unknown";
  toolName?: string;
  paramHint?: string | null;
  resultStr?: string;
  reasoningText?: string;
  rawKind: string;
}

function normalizeBlock(block: StreamBlockEntry["block"]): BlockView {
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
      reasoningText: (payload?.text as string) || "",
      rawKind: kind,
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
    // Claude-code: raw.message.content[*] where type === "tool_result"
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
        return {
          kind: "tool_result",
          toolName: "tool",
          resultStr,
          rawKind: kind,
        };
      }
    }
    return { kind: "tool_result", toolName: "tool", resultStr: "", rawKind: kind };
  }

  if (kind === "system") {
    // Codex thread.started / turn.started etc — usually noise; keep a terse label.
    const type = rawAny?.type as string | undefined;
    return { kind: "system", rawKind: type || "system" };
  }

  return { kind: "unknown", rawKind: kind };
}

function StreamBlockItem({ block }: { block: StreamBlockEntry }) {
  const view = normalizeBlock(block.block);
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
    return (
      <div className="flex items-start gap-2 py-1">
        <Brain className="w-3 h-3 text-purple-400 shrink-0 mt-0.5" />
        <p className="text-xs text-purple-300/70 italic leading-relaxed line-clamp-3">
          {view.reasoningText || ""}
        </p>
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

  const isAssistant = (k: string) => k === "assistant" || k === "assistant_text";
  const executionBlocks = blocks.filter((b) => !isAssistant(b.block.kind));
  const assistantBlocks = blocks.filter((b) => isAssistant(b.block.kind));

  const toolCallCount = executionBlocks.filter(
    (b) => b.block.kind === "tool_call" || b.block.kind === "tool_use",
  ).length;
  const reasoningCount = executionBlocks.filter((b) => b.block.kind === "reasoning").length;

  useEffect(() => {
    onScrollRequest?.();
  }, [blocks.length, onScrollRequest]);

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
                  <StreamBlockItem key={`${block.trace_id}-${block.seq}`} block={block} />
                ))}
              </div>
            )}
          </div>
        )}

        {assistantBlocks.length > 0 && (
          <div className="rounded-lg px-3 py-2 bg-zinc-800 border border-zinc-700 text-sm text-zinc-200">
            <div className="mb-1 flex items-center gap-1.5">
              <Bot className="w-3 h-3 text-zinc-400" />
              <span className="text-xs text-zinc-400">Composing...</span>
            </div>
            <MarkdownContent
              content={
                assistantBlocks
                  .map((b) => {
                    if (b.block.kind === "assistant") {
                      return (b.block.payload?.text as string) || "";
                    }
                    // assistant_text (daemon gateway)
                    const raw = b.block.raw as any;
                    if (typeof raw?.item?.text === "string") return raw.item.text;
                    const contents = raw?.message?.content;
                    if (Array.isArray(contents)) {
                      return contents
                        .filter((c: any) => c?.type === "text" && typeof c.text === "string")
                        .map((c: any) => c.text as string)
                        .join("");
                    }
                    return "";
                  })
                  .join("")
              }
            />
          </div>
        )}
      </div>
    </div>
  );
}
