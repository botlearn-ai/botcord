"use client";

import { useState, useEffect, useRef } from "react";
import { Search, FileText, CheckCircle2, Code2, Brain, HelpCircle, Wrench, ChevronDown, ChevronRight, Bot, AlertTriangle, ListTodo, Info } from "lucide-react";
import type { StreamBlockEntry } from "@/lib/types";
import { animateFadeUp, animateIfMotion, animeStagger, cleanupAnime, createTimelineIfMotion } from "@/lib/anime";
import MarkdownContent from "@/components/ui/MarkdownContent";
import ToolResultContent from "./ToolResultContent";

type MotionAnimation = ReturnType<typeof animateIfMotion>;
type MotionTimeline = ReturnType<typeof createTimelineIfMotion>;

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

const PARAM_HINT_KEYS = [
  "command",
  "cmd",
  "query",
  "path",
  "file_path",
  "filename",
  "tool_name",
  "name",
  "input",
  "arguments",
  "args",
  "rawInput",
  "raw_input",
];

function truncate(text: string, max = 80): string {
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function compactValue(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (isRecord(value) || Array.isArray(value)) {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return null;
}

function summarizeParams(params: unknown): string | null {
  const parsed = parseMaybeJson(params);
  if (parsed == null) return null;
  if (typeof parsed !== "object") return compactValue(parsed);
  if (Array.isArray(parsed)) return parsed.length > 0 ? truncate(JSON.stringify(parsed)) : null;
  const record = parsed as Record<string, unknown>;
  if (Object.keys(record).length === 0) return null;

  for (const key of PARAM_HINT_KEYS) {
    if (key in record) {
      const hint = compactValue(record[key]);
      if (hint) return truncate(hint);
    }
  }

  for (const v of Object.values(record)) {
    const hint = compactValue(v);
    if (hint) return truncate(hint);
  }
  return null;
}

function formatToolParams(params: unknown): string | null {
  const parsed = parseMaybeJson(params);
  if (parsed == null) return null;
  if (typeof parsed === "string") return parsed;
  if (typeof parsed === "number" || typeof parsed === "boolean") return String(parsed);
  if (isRecord(parsed) && Object.keys(parsed).length === 0) return null;
  if (Array.isArray(parsed) && parsed.length === 0) return null;
  try {
    return JSON.stringify(parsed, null, 2);
  } catch {
    return String(parsed);
  }
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
 *  legacy payload shape and the daemon-gateway shape (`raw`). */
interface BlockView {
  kind: "tool_call" | "tool_result" | "reasoning" | "system" | "error" | "todo" | "unknown";
  toolName?: string;
  paramHint?: string | null;
  paramDetails?: string | null;
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
    : typeof rawAny?.payload?.delta === "string" ? rawAny.payload.delta
    : typeof rawAny?.payload?.item?.detail === "string" ? rawAny.payload.item.detail
    : typeof rawAny?.payload?.item?.summary === "string" ? rawAny.payload.item.summary
    : typeof rawAny?.payload?.payload?.item?.detail === "string" ? rawAny.payload.payload.item.detail
    : typeof rawAny?.payload?.payload?.item?.summary === "string" ? rawAny.payload.payload.item.summary
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
    if (b.block.kind === "tool_call" && typeof b.block.payload?.id === "string" && typeof b.block.payload?.name === "string") {
      m[b.block.payload.id] = b.block.payload.name;
    }
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

function stringField(obj: any, key: string): string | undefined {
  const value = obj?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
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

function extractToolCall(raw: any): { name: string; params?: unknown; id?: string } | null {
  const contents = Array.isArray(raw?.message?.content) ? raw.message.content : [];
  const tu = contents.find((c: any) => c?.type === "tool_use");
  if (tu) {
    return {
      name: stringField(tu, "name") ?? "tool",
      params: parseMaybeJson(tu.input ?? tu.arguments),
      id: stringField(tu, "id"),
    };
  }

  const deepseek = extractDeepseekToolCall(raw);
  if (deepseek) return deepseek;

  const item = raw?.item;
  if (item && typeof item === "object") {
    return {
      name: stringField(item, "type") ?? stringField(item, "name") ?? "tool",
      params: item,
      id: stringField(item, "id"),
    };
  }

  const toolCalls = Array.isArray(raw?.tool_calls) ? raw.tool_calls : [];
  const toolCall = toolCalls.find((t: any) => t && typeof t === "object");
  if (toolCall) {
    const fn = toolCall.function && typeof toolCall.function === "object" ? toolCall.function : undefined;
    return {
      name: stringField(fn, "name") ?? stringField(toolCall, "name") ?? "tool",
      params: parseMaybeJson(fn?.arguments ?? toolCall.arguments ?? toolCall.input ?? toolCall.rawInput),
      id: stringField(toolCall, "id"),
    };
  }

  const update = raw?.params?.update ?? raw?.update;
  const acpTool = update?.toolCall ?? update?.tool_call ?? update?.tool;
  if (acpTool && typeof acpTool === "object") {
    return {
      name: stringField(acpTool, "name") ?? stringField(update, "name") ?? "tool",
      params: parseMaybeJson(
        acpTool.rawInput ??
          acpTool.raw_input ??
          acpTool.input ??
          acpTool.arguments ??
          acpTool.args ??
          acpTool.params,
      ) ?? acpTool,
      id: stringField(acpTool, "id") ?? stringField(update, "toolCallId"),
    };
  }

  return null;
}

function extractDeepseekToolCall(raw: any): { name: string; params?: unknown; id?: string } | null {
  const payload = raw?.payload;
  if (!payload || typeof payload !== "object") return null;
  const innerPayload = unwrapDeepseekPayload(raw);
  const event = stringField(raw, "event") ?? stringField(payload, "event");

  if (event === "tool.started") {
    const tool = innerPayload?.tool && typeof innerPayload.tool === "object" ? innerPayload.tool : undefined;
    return {
      name: stringField(innerPayload, "name") ?? stringField(tool, "name") ?? "tool",
      params: parseMaybeJson(
        innerPayload?.input ??
          innerPayload?.arguments ??
          innerPayload?.params ??
          tool?.input ??
          tool?.rawInput ??
          tool?.arguments ??
          tool?.params,
      ),
      id: stringField(innerPayload, "id") ?? stringField(tool, "id"),
    };
  }

  if (event === "item.started") {
    const inner = innerPayload ?? {};
    const item = inner.item && typeof inner.item === "object" ? inner.item : undefined;
    const tool = inner.tool && typeof inner.tool === "object" ? inner.tool : item?.tool;
    const metadata = item?.metadata && typeof item.metadata === "object" ? item.metadata : undefined;
    const metadataCommand =
      metadata && (metadata.command ?? metadata.cmd)
        ? { [metadata.command ? "command" : "cmd"]: metadata.command ?? metadata.cmd }
        : undefined;
    const itemParams = parseMaybeJson(
      item?.input ??
        item?.arguments ??
        item?.params ??
        metadata?.input ??
        metadata?.arguments ??
        metadata?.params ??
        metadataCommand ??
        item?.detail,
    );
    return {
      name:
        stringField(tool, "name") ??
        stringField(inner, "name") ??
        stringField(item, "name") ??
        inferDeepseekToolName(item) ??
        stringField(item, "type") ??
        "tool",
      params: parseMaybeJson(
        tool?.input ??
          tool?.rawInput ??
          tool?.arguments ??
          tool?.params ??
          inner.input ??
          inner.arguments ??
          inner.params ??
          item?.input ??
          item?.arguments ??
          item?.params ??
          metadata?.input ??
          metadata?.arguments ??
          metadata?.params ??
          metadataCommand,
      ) ?? itemParams ?? tool ?? item,
      id:
        stringField(tool, "id") ??
        stringField(inner, "id") ??
        stringField(item, "id") ??
        stringField(payload, "item_id"),
    };
  }

  return null;
}

function extractToolResult(raw: any): { name?: string; result: string; id?: string } | null {
  const deepseek = extractDeepseekToolResult(raw);
  if (deepseek) return deepseek;

  const item = raw?.item;
  if (item && typeof item === "object") {
    const result = item.output ?? item.result ?? item.text ?? item.summary ?? item.diff ?? item.error ?? item;
    return {
      name: stringField(item, "type") ?? stringField(item, "name"),
      result: stringifyDetails(result),
      id: stringField(item, "id"),
    };
  }

  if (raw?.role === "tool") {
    return {
      result: stringifyDetails(raw.content),
      id: stringField(raw, "tool_call_id"),
    };
  }

  const update = raw?.params?.update ?? raw?.update;
  const acpTool = update?.toolCall ?? update?.tool_call ?? update?.tool;
  if (acpTool && typeof acpTool === "object") {
    const result =
      acpTool.output ??
      acpTool.result ??
      acpTool.content ??
      acpTool.error ??
      update.content ??
      update;
    return {
      name: stringField(acpTool, "name") ?? stringField(update, "name"),
      result: stringifyDetails(result),
      id: stringField(acpTool, "id") ?? stringField(update, "toolCallId"),
    };
  }

  return null;
}

function extractDeepseekToolResult(raw: any): { name?: string; result: string; id?: string } | null {
  const payload = raw?.payload;
  if (!payload || typeof payload !== "object") return null;
  const innerPayload = unwrapDeepseekPayload(raw);
  const event = stringField(raw, "event") ?? stringField(payload, "event");

  if (event === "tool.completed") {
    const result =
      innerPayload?.output ??
      innerPayload?.result ??
      innerPayload?.content ??
      innerPayload?.error ??
      innerPayload ??
      payload;
    return {
      name: stringField(innerPayload, "name"),
      result: stringifyDetails(result),
      id: stringField(innerPayload, "id"),
    };
  }

  if (event === "item.completed" || event === "item.failed") {
    const inner = innerPayload ?? {};
    const item = inner.item && typeof inner.item === "object" ? inner.item : undefined;
    const result =
      item?.output ??
      item?.result ??
      item?.content ??
      item?.detail ??
      item?.summary ??
      item?.error ??
      inner.output ??
      inner.result ??
      inner.error ??
      item ??
      inner;
    return {
      name:
        stringField(item, "name") ??
        inferDeepseekToolName(item) ??
        stringField(inner, "name") ??
        stringField(item, "type"),
      result: stringifyDetails(result),
      id: stringField(item, "id") ?? stringField(inner, "id") ?? stringField(payload, "item_id"),
    };
  }

  return null;
}

function unwrapDeepseekPayload(raw: any): any {
  const payload = raw?.payload;
  if (!payload || typeof payload !== "object") return undefined;
  const nested = payload.payload;
  if (nested && typeof nested === "object") {
    const outerEvent = stringField(payload, "event");
    if (
      outerEvent ||
      nested.item ||
      nested.tool ||
      nested.turn ||
      nested.kind ||
      nested.output ||
      nested.result ||
      nested.error
    ) {
      return nested;
    }
  }
  return payload;
}

function normalizeBlock(
  block: StreamBlockEntry["block"],
  ctx?: { toolNameById?: Record<string, string> },
): BlockView {
  const { kind, payload, raw } = block;
  const rawAny = raw as any;

  // Legacy shape ------------------------------------------------------------
  if (kind === "tool_call") {
    const rawCall = extractToolCall(rawAny);
    const params =
      payload?.params ??
      payload?.input ??
      payload?.arguments ??
      rawCall?.params ??
      payload?.details;
    return {
      kind: "tool_call",
      toolName: (payload?.name as string) || rawCall?.name || "tool",
      paramHint: summarizeParams(params),
      paramDetails: formatToolParams(params),
      rawKind: kind,
    };
  }
  if (kind === "tool_result" && payload) {
    const id = typeof payload.tool_use_id === "string" ? payload.tool_use_id : undefined;
    const rawResult = extractToolResult(rawAny);
    return {
      kind: "tool_result",
      toolName: (payload.name as string) || rawResult?.name || (id && ctx?.toolNameById?.[id]) || "tool",
      resultStr: String(payload.result ?? rawResult?.result ?? ""),
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
    const call = extractToolCall(rawAny);
    if (call) {
      return {
        kind: "tool_call",
        toolName: call.name,
        paramHint: summarizeParams(call.params),
        paramDetails: formatToolParams(call.params),
        rawKind: kind,
      };
    }

    // Claude-code: raw.message.content[*] where type === "tool_use"
    const contents = rawAny?.message?.content;
    if (Array.isArray(contents)) {
      const tu = contents.find((c: any) => c?.type === "tool_use");
      if (tu) {
        return {
          kind: "tool_call",
          toolName: (tu.name as string) || "tool",
          paramHint: summarizeParams(tu.input || tu.arguments),
          paramDetails: formatToolParams(tu.input || tu.arguments),
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
        paramDetails: formatToolParams(item),
        rawKind: kind,
      };
    }
    return { kind: "tool_call", toolName: "tool", rawKind: kind };
  }

  if (kind === "tool_result") {
    const directResult = extractToolResult(rawAny);
    if (directResult) {
      return {
        kind: "tool_result",
        toolName: directResult.name || "tool",
        resultStr: directResult.result,
        rawKind: kind,
      };
    }

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
    const details = view.paramDetails || "";
    return (
      <div className="py-1">
        <button
          onClick={() => details && setResultExpanded(!resultExpanded)}
          className="flex items-center gap-2 group min-w-0 text-left"
        >
          <ToolCallIcon name={name} />
          <span className="text-xs font-mono text-cyan-400">{name}</span>
          {details && (
            resultExpanded
              ? <ChevronDown className="inline ml-1 w-2.5 h-2.5 text-zinc-500" />
              : <ChevronRight className="inline ml-1 w-2.5 h-2.5 text-zinc-500" />
          )}
        </button>
        {view.paramHint && !resultExpanded && (
          <p className="mt-0.5 ml-5 text-[10px] text-zinc-500 truncate max-w-[400px]">
            {view.paramHint}
          </p>
        )}
        {details && resultExpanded && (
          <ToolResultContent result={details} toolName={`${name} input`} unwrapContentArray={false} />
        )}
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
  showComposing = false,
  onScrollRequest,
}: {
  blocks: StreamBlockEntry[];
  defaultExpanded?: boolean;
  showComposing?: boolean;
  onScrollRequest?: () => void;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded ?? false);
  const [renderExpandedContent, setRenderExpandedContent] = useState(defaultExpanded ?? false);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const rowAnimationRef = useRef<MotionAnimation>(null);
  const panelAnimationRef = useRef<MotionTimeline>(null);
  const composingAnimationRef = useRef<MotionAnimation>(null);
  const previousRowKeysRef = useRef<Set<string>>(new Set());
  const previousComposingTextRef = useRef("");

  const isAssistant = (k: string) => k === "assistant" || k === "assistant_text";
  const executionBlocks = blocks.filter((b) => !isAssistant(b.block.kind));

  // Build tool_use_id → name map so tool_result rows can show the real tool name.
  const toolNameById = buildToolNameById(blocks);
  const displayBlocks = executionBlocks.filter(
    (b) => normalizeBlock(b.block, { toolNameById }).kind !== "system",
  );

  const normalized = displayBlocks.map((b) => normalizeBlock(b.block, { toolNameById }).kind);
  const toolCallCount = normalized.filter((k) => k === "tool_call").length;
  const reasoningCount = normalized.filter((k) => k === "reasoning").length;
  const displayBlockKeys = displayBlocks.map((block) => `${block.trace_id}-${block.seq}`);
  const displayBlockKeySignature = displayBlockKeys.join("|");

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
        if (
          k === "assistant_text" &&
          raw?.event === "item.delta" &&
          (raw?.payload?.kind === "agent_message" || raw?.payload?.payload?.kind === "agent_message")
        ) {
          parts.push(
            typeof raw?.payload?.delta === "string"
              ? raw.payload.delta
              : typeof raw?.payload?.payload?.delta === "string"
                ? raw.payload.payload.delta
                : "",
          );
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
  const composingText = showComposing ? buildComposingText() : "";

  useEffect(() => {
    onScrollRequest?.();
  }, [blocks.length, onScrollRequest]);

  useEffect(() => () => {
    cleanupAnime(rowAnimationRef.current);
    cleanupAnime(panelAnimationRef.current);
    cleanupAnime(composingAnimationRef.current);
  }, []);

  useEffect(() => {
    if (expanded) {
      cleanupAnime(panelAnimationRef.current);
      panelAnimationRef.current = null;
      setRenderExpandedContent(true);
      return;
    }

    const content = contentRef.current;
    cleanupAnime(panelAnimationRef.current);

    if (!content) {
      setRenderExpandedContent(false);
      return;
    }

    const animation = createTimelineIfMotion({
      onComplete: () => {
        panelAnimationRef.current = null;
        setRenderExpandedContent(false);
      },
    });
    panelAnimationRef.current = animation;

    if (!animation) {
      setRenderExpandedContent(false);
      return;
    }

    animation.add(content, {
      opacity: 0,
      translateY: -4,
      duration: 120,
      ease: "in(2)",
    }, 0);
  }, [expanded]);

  useEffect(() => {
    if (!renderExpandedContent) return;

    const frameId = window.requestAnimationFrame(() => {
      const content = contentRef.current;
      if (!content) return;

      cleanupAnime(panelAnimationRef.current);
      panelAnimationRef.current = createTimelineIfMotion();
      if (panelAnimationRef.current) {
        panelAnimationRef.current.add(content, {
          opacity: [0, 1],
          translateY: [6, 0],
          duration: 180,
          ease: "out(3)",
        }, 0);
      } else {
        content.style.opacity = "1";
        content.style.transform = "translateY(0)";
      }
    });

    return () => window.cancelAnimationFrame(frameId);
  }, [renderExpandedContent]);

  useEffect(() => {
    if (!renderExpandedContent) {
      previousRowKeysRef.current = new Set(displayBlockKeys);
      previousComposingTextRef.current = composingText;
      return;
    }

    const frameId = window.requestAnimationFrame(() => {
      const content = contentRef.current;
      if (!content) return;

      const previousKeys = previousRowKeysRef.current;
      const rows = Array.from(content.querySelectorAll<HTMLElement>("[data-stream-block-row]"));
      const enteringRows = rows.filter((row) => {
        const rowKey = row.dataset.streamBlockKey;
        return !!rowKey && !previousKeys.has(rowKey);
      });

      // Stop the previous batch's animation WITHOUT reverting it. revert()
      // restores those rows to their opacity:0 baseline (set imperatively
      // below) — and since they are no longer "entering", they'd never be
      // animated back to 1, leaving them invisible but still occupying height.
      // During fast multi-block streaming this strands every row but the last
      // at opacity:0, producing a large blank gap above the visible content.
      rowAnimationRef.current?.pause();
      rowAnimationRef.current = null;

      // Force every already-settled row fully visible, clearing any
      // opacity/transform left behind by an interrupted enter animation.
      rows.forEach((row) => {
        if (enteringRows.includes(row)) return;
        row.style.opacity = "1";
        row.style.transform = "translateY(0)";
      });

      if (enteringRows.length > 0) {
        enteringRows.forEach((row) => {
          row.style.opacity = "0";
          row.style.transform = "translateY(6px)";
        });
        const rowAnimation = animateIfMotion(enteringRows, {
          opacity: [0, 1],
          translateY: [6, 0],
          duration: 210,
          delay: animeStagger(24),
          ease: "out(3)",
        });
        rowAnimationRef.current = rowAnimation;
        if (!rowAnimation) {
          enteringRows.forEach((row) => {
            row.style.opacity = "1";
            row.style.transform = "translateY(0)";
          });
        }
      }

      previousRowKeysRef.current = new Set(displayBlockKeys);
    });

    return () => window.cancelAnimationFrame(frameId);
  }, [renderExpandedContent, displayBlockKeySignature]);

  useEffect(() => {
    const hadComposingText = previousComposingTextRef.current.length > 0;
    if (!renderExpandedContent || !composingText || hadComposingText) {
      previousComposingTextRef.current = composingText;
      return;
    }

    const frameId = window.requestAnimationFrame(() => {
      const composing = contentRef.current?.querySelector<HTMLElement>("[data-stream-composing]");
      if (!composing) return;

      cleanupAnime(composingAnimationRef.current);
      composingAnimationRef.current = animateFadeUp(composing, 20);
      if (!composingAnimationRef.current) {
        composing.style.opacity = "1";
        composing.style.transform = "translateY(0)";
      }
      previousComposingTextRef.current = composingText;
    });

    return () => window.cancelAnimationFrame(frameId);
  }, [renderExpandedContent, composingText]);

  if (blocks.length === 0 || displayBlocks.length === 0) return null;

  const summaryParts: string[] = [];
  if (toolCallCount > 0) summaryParts.push(`${toolCallCount} tool call${toolCallCount !== 1 ? "s" : ""}`);
  if (reasoningCount > 0) summaryParts.push(`${reasoningCount} reasoning`);
  if (summaryParts.length === 0) summaryParts.push(`${displayBlocks.length} step${displayBlocks.length !== 1 ? "s" : ""}`);

  return (
    <div className="flex justify-start">
      <div className="max-w-[85%] space-y-2">
        {displayBlocks.length > 0 && (
          <div className="rounded-lg border border-zinc-700/40 bg-zinc-900/40 overflow-hidden">
            <button
              onClick={() => setExpanded(!expanded)}
              className="flex items-center gap-1.5 w-full px-3 py-1.5 text-xs text-zinc-400 hover:text-zinc-300 transition-colors"
            >
              <ChevronRight className={`w-3 h-3 transition-transform duration-200 ${expanded ? "rotate-90" : ""}`} />
              <Wrench className="w-3 h-3" />
              <span>{summaryParts.join(", ")}</span>
            </button>
            {renderExpandedContent && (
              <div
                ref={contentRef}
                className="border-t border-zinc-800/60 px-3 py-1 divide-y divide-zinc-800/40 will-change-transform"
              >
                {displayBlocks.map((block) => {
                  const blockKey = `${block.trace_id}-${block.seq}`;
                  return (
                    <div
                      key={blockKey}
                      data-stream-block-row
                      data-stream-block-key={blockKey}
                    >
                      <StreamBlockItem
                        block={block}
                        toolNameById={toolNameById}
                      />
                    </div>
                  );
                })}
                {composingText && (
                  <div data-stream-composing className="py-2 will-change-transform">
                    <div className="mb-1 flex items-center gap-1.5">
                      <Bot className="w-3 h-3 text-zinc-400" />
                      <span className="text-xs text-zinc-400">Composing...</span>
                    </div>
                    <MarkdownContent content={composingText} />
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
