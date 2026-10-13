"use client";

import Button from "@/components/ui/Button";
import SignalDot from "@/components/ui/SignalDot";
import { useState, useEffect } from "react";
import type { ReactNode } from "react";
import { Search, FileText, CheckCircle2, Circle, Code2, Brain, HelpCircle, ChevronRight, AlertTriangle, ListTodo } from "lucide-react";
import type { StreamBlockEntry } from "@/lib/types";
import { useLanguage } from "@/lib/i18n";
import { streamProcess } from "@/lib/i18n/translations/dashboard";
import ToolResultContent from "./ToolResultContent";

/** Timeline shows the newest steps; older ones fold behind one link. */
const VISIBLE_STEP_MAX = 8;

/** Icon for a tool_call based on tool name heuristics. */
function ToolCallIcon({ name }: { name: string }) {
  const n = name.toLowerCase();
  if (n.includes("search") || n.includes("find") || n.includes("query")) {
    return <Search aria-hidden strokeWidth={1.75} className="size-4" />;
  }
  if (n.includes("read") || n.includes("get") || n.includes("fetch") || n.includes("list")) {
    return <FileText aria-hidden strokeWidth={1.75} className="size-4" />;
  }
  return <Code2 aria-hidden strokeWidth={1.75} className="size-4" />;
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

function streamBlockKey(block: StreamBlockEntry): string {
  return `${block.trace_id}-${block.seq}`;
}

function streamBlockTime(block: StreamBlockEntry): number {
  const time = Date.parse(block.created_at);
  return Number.isNaN(time) ? 0 : time;
}

function compareStreamBlockTimeAsc(a: StreamBlockEntry, b: StreamBlockEntry): number {
  const timeDiff = streamBlockTime(a) - streamBlockTime(b);
  if (timeDiff !== 0) return timeDiff;
  const seqDiff = a.seq - b.seq;
  if (seqDiff !== 0) return seqDiff;
  return a.trace_id.localeCompare(b.trace_id);
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
  /** Runtime tool id; pairs a tool_call with its tool_result. */
  toolId?: string;
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
      toolId: stringField(payload, "id") ?? rawCall?.id,
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
      toolId: id ?? rawResult?.id,
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
        toolId: call.id,
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
          toolId: stringField(tu, "id"),
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
        toolId: stringField(item, "id"),
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
        toolId: directResult.id,
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
          toolId: id,
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

/** Process step shown in the timeline. A tool_call and its tool_result are
 *  folded into one tool step so the user reads one row per action. */
type ProcessStep =
  | { kind: "tool"; key: string; call?: BlockView; result?: BlockView }
  | { kind: "reasoning" | "error" | "todo" | "unknown"; key: string; view: BlockView };

type ToolStep = Extract<ProcessStep, { kind: "tool" }>;

function buildProcessSteps(blocks: StreamBlockEntry[], toolNameById: Record<string, string>): ProcessStep[] {
  const steps: ProcessStep[] = [];
  const toolById = new Map<string, ToolStep>();

  for (const block of blocks) {
    const key = streamBlockKey(block);
    const view = normalizeBlock(block.block, { toolNameById });

    if (view.kind === "tool_call") {
      const existing = view.toolId ? toolById.get(view.toolId) : undefined;
      if (existing && !existing.result) {
        existing.call = view;
        continue;
      }
      const step: ToolStep = { kind: "tool", key, call: view };
      steps.push(step);
      if (view.toolId) toolById.set(view.toolId, step);
      continue;
    }

    if (view.kind === "tool_result") {
      let match = view.toolId ? toolById.get(view.toolId) : undefined;
      if (!match && !view.toolId) {
        // No id to pair on: attach to the latest open call with the same name.
        for (let i = steps.length - 1; i >= 0; i -= 1) {
          const step = steps[i];
          if (step.kind === "tool" && !step.result && step.call?.toolName === view.toolName) {
            match = step;
            break;
          }
        }
      }
      if (match && !match.result) {
        match.result = view;
      } else {
        steps.push({ kind: "tool", key, result: view });
      }
      continue;
    }

    if (view.kind === "system") continue;
    steps.push({ kind: view.kind, key, view });
  }

  return steps;
}

function toolStepName(step: ToolStep): string {
  const callName = step.call?.toolName;
  if (callName && callName !== "tool") return callName;
  return step.result?.toolName || callName || "tool";
}

function formatDuration(ms: number): string | null {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 1) return null;
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

const ICON = "size-4 shrink-0";

/** Compose the streamed prose by walking every block — covers mixed
 *  Claude-code blocks where the daemon labelled the block as `tool_use`
 *  because content[] held both `text` and `tool_use` items. */
export function buildComposingText(blocks: StreamBlockEntry[]): string {
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

function StepRow({
  icon,
  expandable,
  expanded,
  onToggle,
  children,
}: {
  icon: ReactNode;
  expandable: boolean;
  expanded: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  const body = (
    <>
      <span className="flex min-w-0 flex-1 items-center gap-2">{children}</span>
      {expandable && (
        <ChevronRight
          aria-hidden
          strokeWidth={1.75}
          className={`${ICON} text-text-secondary transition-transform duration-[var(--bc-duration-fast)] ease-[var(--bc-ease-standard)] ${expanded ? "rotate-90" : ""}`}
        />
      )}
    </>
  );
  return (
    <div className="relative pl-8">
      <span className="absolute left-0 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center rounded-full border border-border bg-surface text-text-secondary">
        {icon}
      </span>
      {expandable ? (
        <Button
          variant="row"
          onClick={onToggle}
          aria-expanded={expanded}
          className="flex min-h-7 items-center gap-2 px-1.5 py-1.5"
        >
          {body}
        </Button>
      ) : (
        <div className="flex min-h-7 items-center gap-2 px-1.5 py-1 text-sm">{body}</div>
      )}
    </div>
  );
}

function ProcessStepItem({
  step,
  live,
  labels,
}: {
  step: ProcessStep;
  live: boolean;
  labels: (typeof streamProcess)["en"];
}) {
  const [expanded, setExpanded] = useState(false);
  const toggle = () => setExpanded((value) => !value);

  if (step.kind === "tool") {
    const name = toolStepName(step);
    const params = step.call?.paramDetails || "";
    const result = step.result?.resultStr || "";
    const running = live && !step.result;
    return (
      <li>
        <StepRow
          icon={<ToolCallIcon name={name} />}
          expandable={Boolean(params || result)}
          expanded={expanded}
          onToggle={toggle}
        >
          <span className="shrink-0 font-mono text-[13px] text-text-primary">{name}</span>
          {step.call?.paramHint && (
            <span className="min-w-0 truncate font-mono text-[13px] text-text-secondary">{step.call.paramHint}</span>
          )}
          <span className="ml-auto shrink-0 pl-2">
            {step.result ? (
              <CheckCircle2 aria-label={labels.done} strokeWidth={1.75} className={`${ICON} text-success`} />
            ) : running ? (
              <span className="type-caption text-accent-text">{labels.running}</span>
            ) : null}
          </span>
        </StepRow>
        {expanded && (
          <div className="mt-1 space-y-2 pb-1 pl-8">
            {params && <ToolResultContent result={params} toolName={`${name} input`} unwrapContentArray={false} />}
            {result && <ToolResultContent result={result} toolName={name} />}
          </div>
        )}
      </li>
    );
  }

  const { view } = step;

  if (step.kind === "reasoning") {
    const text = view.reasoningText || "";
    return (
      <li>
        <StepRow
          icon={<Brain aria-hidden strokeWidth={1.75} className="size-4" />}
          expandable={Boolean(text)}
          expanded={expanded}
          onToggle={toggle}
        >
          <span className="shrink-0 text-sm text-text-primary">{labels.thinking}</span>
          {text && !expanded && <span className="min-w-0 truncate type-body-sm text-text-secondary">{text}</span>}
        </StepRow>
        {text && expanded && (
          <p className="pb-1 pl-9.5 type-body-sm whitespace-pre-wrap break-words text-text-secondary">{text}</p>
        )}
      </li>
    );
  }

  if (step.kind === "error") {
    return (
      <li>
        <StepRow
          icon={<AlertTriangle aria-hidden strokeWidth={1.75} className="size-4 text-danger" />}
          expandable={false}
          expanded={false}
          onToggle={toggle}
        >
          <span className="min-w-0 break-words text-sm text-danger">{view.errorText || labels.error}</span>
        </StepRow>
      </li>
    );
  }

  if (step.kind === "todo") {
    const items = view.todoItems ?? [];
    return (
      <li>
        <StepRow
          icon={<ListTodo aria-hidden strokeWidth={1.75} className="size-4" />}
          expandable={false}
          expanded={false}
          onToggle={toggle}
        >
          <span className="shrink-0 text-sm text-text-primary">{labels.todo}</span>
          {items.length > 0 && <span className="type-caption text-text-secondary">{labels.items(items.length)}</span>}
        </StepRow>
        {items.length > 0 && (
          <ul className="space-y-0.5 pb-1 pl-9.5">
            {items.map((item, idx) => (
              <li key={idx} className="flex min-w-0 items-center gap-1.5 type-body-sm text-text-secondary">
                {item.status === "completed" ? (
                  <CheckCircle2 aria-hidden strokeWidth={1.75} className={`${ICON} text-success`} />
                ) : (
                  <Circle aria-hidden strokeWidth={1.75} className={`${ICON} ${item.status === "in_progress" ? "text-accent-text" : ""}`} />
                )}
                <span className={`truncate ${item.status === "completed" ? "line-through" : ""}`}>{item.text}</span>
              </li>
            ))}
          </ul>
        )}
      </li>
    );
  }

  return (
    <li>
      <StepRow
        icon={<HelpCircle aria-hidden strokeWidth={1.75} className="size-4" />}
        expandable={false}
        expanded={false}
        onToggle={toggle}
      >
        <span className="truncate font-mono text-[13px] text-text-secondary">{view.rawKind}</span>
      </StepRow>
    </li>
  );
}

/**
 * Agent work process, rendered inside the agent message bubble above the reply.
 * Collapsed it is one line of secondary text; expanded it is a Node·Cord
 * timeline (steps connected by a rail). While `live`, the line shows what the
 * agent is doing right now with a breathing signal dot.
 */
export default function StreamBlocksView({
  blocks,
  live = false,
  defaultExpanded = false,
  onScrollRequest,
}: {
  blocks: StreamBlockEntry[];
  live?: boolean;
  defaultExpanded?: boolean;
  onScrollRequest?: () => void;
}) {
  const locale = useLanguage();
  const labels = streamProcess[locale];
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [olderExpanded, setOlderExpanded] = useState(false);
  // Set after mount only, so SSR and hydration render the same text.
  const [now, setNow] = useState<number | null>(null);

  const sortedBlocks = [...blocks].sort(compareStreamBlockTimeAsc);
  const toolNameById = buildToolNameById(blocks);
  const steps = buildProcessSteps(
    sortedBlocks.filter((b) => b.block.kind !== "assistant" && b.block.kind !== "assistant_text"),
    toolNameById,
  );
  const olderCount = Math.max(0, steps.length - VISIBLE_STEP_MAX);
  const shownSteps = olderExpanded ? steps : steps.slice(olderCount);

  useEffect(() => {
    onScrollRequest?.();
  }, [blocks.length, expanded, onScrollRequest]);

  useEffect(() => {
    if (!live) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [live]);

  if (steps.length === 0 && !live) return null;

  const startedAt = sortedBlocks.length > 0 ? streamBlockTime(sortedBlocks[0]) : 0;
  const endedAt = live ? now : sortedBlocks.length > 0 ? streamBlockTime(sortedBlocks[sortedBlocks.length - 1]) : 0;
  const duration = startedAt > 0 && endedAt ? formatDuration(Math.max(0, endedAt - startedAt)) : null;

  let headline: string;
  if (live) {
    const lastStep = steps[steps.length - 1];
    const lastKind = sortedBlocks[sortedBlocks.length - 1]?.block.kind;
    if (lastStep?.kind === "tool" && !lastStep.result) headline = labels.runningTool(toolStepName(lastStep));
    else if (lastKind === "assistant" || lastKind === "assistant_text") headline = labels.replying;
    else headline = labels.thinkingNow;
  } else {
    const reasoningCount = steps.filter((s) => s.kind === "reasoning").length;
    const toolCount = steps.filter((s) => s.kind === "tool").length;
    const parts: string[] = [];
    if (reasoningCount > 0) parts.push(labels.thoughtSteps(reasoningCount));
    if (toolCount > 0) parts.push(labels.toolCalls(toolCount));
    if (parts.length === 0) parts.push(labels.steps(steps.length));
    headline = parts.join(" · ");
  }

  return (
    <div className="mb-1.5" data-stream-process>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        disabled={steps.length === 0}
        className="-mx-2 h-7 max-w-[calc(100%+1rem)] gap-1.5 px-2 font-normal disabled:cursor-default disabled:opacity-100"
      >
        {live && <SignalDot status="thinking" size="xs" className="mr-0.5" />}
        <span className="truncate type-caption text-text-secondary">{headline}</span>
        {duration && <span className="shrink-0 type-caption text-text-secondary">· {duration}</span>}
        {steps.length > 0 && (
          <ChevronRight
            aria-hidden
            strokeWidth={1.75}
            className={`${ICON} text-text-secondary transition-transform duration-[var(--bc-duration-fast)] ease-[var(--bc-ease-standard)] ${expanded ? "rotate-90" : ""}`}
          />
        )}
      </Button>
      {expanded && steps.length > 0 && (
        <div className="mt-1 animate-[bc-fade-in_var(--bc-duration-base)_var(--bc-ease-enter)] border-b border-border pb-2">
          {olderCount > 0 && (
            <Button
              variant="inline"
              onClick={() => setOlderExpanded(!olderExpanded)}
              aria-expanded={olderExpanded}
              className="mb-1 ml-9.5 type-caption"
            >
              {olderExpanded ? labels.hideOlder : labels.showOlder(olderCount)}
            </Button>
          )}
          <ol className="relative space-y-0.5 before:absolute before:bottom-3 before:left-3 before:top-3 before:w-px before:bg-border">
            {shownSteps.map((step) => (
              <ProcessStepItem key={step.key} step={step} live={live} labels={labels} />
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}
