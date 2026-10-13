import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import StreamBlocksView, { buildComposingText } from "./StreamBlocksView";
import type { StreamBlockEntry } from "@/lib/types";

vi.mock("next/navigation", () => ({ usePathname: () => "/en/chats" }));

function mixedToolUseBlock(): StreamBlockEntry {
  return {
    trace_id: "tr_1",
    seq: 1,
    created_at: "2026-05-25T00:00:00.000Z",
    block: {
      kind: "tool_use",
      raw: {
        message: {
          content: [
            { type: "text", text: "draft answer" },
            { type: "tool_use", id: "tool_1", name: "Read", input: { file_path: "README.md" } },
          ],
        },
      },
    },
  };
}

function toolCallBlock({
  traceId = "tr_many",
  seq,
  createdAt,
  name,
  id,
}: {
  traceId?: string;
  seq: number;
  createdAt: string;
  name: string;
  id?: string;
}): StreamBlockEntry {
  return {
    trace_id: traceId,
    seq,
    created_at: createdAt,
    block: {
      kind: "tool_call",
      payload: { name, id, params: { cmd: name } },
    },
  };
}

function toolResultBlock({ seq, createdAt, id, result }: { seq: number; createdAt: string; id: string; result: string }): StreamBlockEntry {
  return {
    trace_id: "tr_many",
    seq,
    created_at: createdAt,
    block: { kind: "tool_result", payload: { tool_use_id: id, result } },
  };
}

function render(props: React.ComponentProps<typeof StreamBlocksView>): string {
  return renderToStaticMarkup(React.createElement(StreamBlocksView, props));
}

describe("StreamBlocksView", () => {
  it("collapses to a one-line summary with duration by default", () => {
    const html = render({
      blocks: [
        toolCallBlock({ seq: 1, createdAt: "2026-05-25T00:00:00.000Z", name: "exec_shell", id: "t1" }),
        toolResultBlock({ seq: 2, createdAt: "2026-05-25T00:00:18.000Z", id: "t1", result: "ok" }),
      ],
    });

    expect(html).toContain("Used 1 tool");
    expect(html).toContain("18s");
    expect(html).not.toContain("exec_shell");
  });

  it("pairs a tool call with its result into one step", () => {
    const html = render({
      defaultExpanded: true,
      blocks: [
        toolCallBlock({ seq: 1, createdAt: "2026-05-25T00:00:00.000Z", name: "exec_shell", id: "t1" }),
        toolResultBlock({ seq: 2, createdAt: "2026-05-25T00:00:01.000Z", id: "t1", result: "ok" }),
      ],
    });

    expect(html.match(/<li>/g)).toHaveLength(1);
    expect(html).toContain('aria-label="Done"');
  });

  it("shows the running tool while live", () => {
    const html = render({
      live: true,
      blocks: [toolCallBlock({ seq: 1, createdAt: "2026-05-25T00:00:00.000Z", name: "search_web", id: "t1" })],
    });

    expect(html).toContain("Running search_web");
    expect(html).toContain('data-status="thinking"');
  });

  it("shows replying while live with only assistant text", () => {
    const html = render({
      live: true,
      blocks: [{
        trace_id: "tr_a",
        seq: 1,
        created_at: "2026-05-25T00:00:00.000Z",
        block: { kind: "assistant", payload: { text: "hi" } },
      }],
    });

    expect(html).toContain("Replying");
  });

  it("renders nothing once delivered without process steps", () => {
    const html = render({
      blocks: [{
        trace_id: "tr_a",
        seq: 1,
        created_at: "2026-05-25T00:00:00.000Z",
        block: { kind: "assistant", payload: { text: "hi" } },
      }],
    });

    expect(html).toBe("");
  });

  it("treats DeepSeek thinking markers as status, not reasoning steps", () => {
    const marker = (seq: number, raw: Record<string, unknown>): StreamBlockEntry => ({
      trace_id: "tr_ds",
      seq,
      created_at: `2026-05-25T00:00:0${seq}.000Z`,
      block: {
        kind: "thinking",
        payload: { ...raw, details: typeof raw.label === "string" ? raw.label : JSON.stringify(raw) },
        raw,
      },
    });
    const blocks: StreamBlockEntry[] = [
      marker(0, { phase: "started", source: "dispatcher" }),
      marker(1, { phase: "started", label: "Thinking", source: "runtime" }),
      marker(2, { event: "item.delta", phase: "updated", label: "Reasoning", source: "runtime" }),
      {
        trace_id: "tr_ds",
        seq: 3,
        created_at: "2026-05-25T00:00:02.500Z",
        block: { kind: "other", payload: { terminal: true, event: "turn.completed" }, raw: { event: "turn.completed", payload: {} } },
      },
    ];

    const delivered = render({ defaultExpanded: true, blocks });
    expect(delivered).toContain("Thought");
    expect(delivered).toContain("2s");
    expect(delivered).not.toContain("<li");
    expect(delivered).not.toContain("Reasoning");
    expect(delivered).not.toContain("dispatcher");
    expect(delivered).not.toContain("other");

    const live = render({ live: true, blocks: blocks.slice(0, 3) });
    expect(live).toContain("Thinking");
    expect(live).not.toContain("Thought");
  });

  it("extracts composing text from mixed tool_use blocks", () => {
    expect(buildComposingText([mixedToolUseBlock()])).toBe("draft answer");
  });

  it("falls back to raw tool input when normalized payload is empty", () => {
    const html = render({
      defaultExpanded: true,
      blocks: [{
        trace_id: "tr_2",
        seq: 1,
        created_at: "2026-05-25T00:00:00.000Z",
        block: {
          kind: "tool_call",
          payload: {},
          raw: {
            event: "item.started",
            payload: {
              item: {
                id: "item_exec",
                kind: "tool_call",
                summary: "exec_shell started",
                detail: "{\"cmd\":\"botcord-daemon status\"}",
              },
            },
          },
        },
      }],
    });

    expect(html).toContain("exec_shell");
    expect(html).toContain("botcord-daemon status");
  });

  it("prefers wrapped DeepSeek raw tool input over generic payload details", () => {
    const html = render({
      defaultExpanded: true,
      blocks: [{
        trace_id: "tr_2b",
        seq: 1,
        created_at: "2026-05-25T00:00:00.000Z",
        block: {
          kind: "tool_call",
          payload: { details: "exec_shell" },
          raw: {
            event: "item.started",
            payload: {
              seq: 922,
              event: "item.started",
              payload: {
                item: {
                  id: "item_exec",
                  kind: "tool_call",
                  status: "in_progress",
                  summary: "exec_shell started",
                  detail: "{\"cmd\":\"botcord-daemon status\"}",
                },
              },
            },
          },
        },
      }],
    });

    expect(html).toContain("exec_shell");
    expect(html).toContain("botcord-daemon status");
  });

  it("pairs raw item.started and item.completed by item id", () => {
    const html = render({
      defaultExpanded: true,
      blocks: [
        {
          trace_id: "tr_3",
          seq: 1,
          created_at: "2026-05-25T00:00:00.000Z",
          block: {
            kind: "tool_call",
            payload: {},
            raw: {
              event: "item.started",
              payload: { item: { id: "item_exec", kind: "tool_call", summary: "exec_shell started", detail: "{\"cmd\":\"pwd\"}" } },
            },
          },
        },
        {
          trace_id: "tr_3",
          seq: 2,
          created_at: "2026-05-25T00:00:01.000Z",
          block: {
            kind: "tool_result",
            payload: {},
            raw: {
              event: "item.completed",
              payload: { item: { id: "item_exec", kind: "tool_call", summary: "exec_shell: daemon: pid 49616", detail: "daemon: pid 49616 (alive)" } },
            },
          },
        },
      ],
    });

    expect(html.match(/<li>/g)).toHaveLength(1);
    expect(html).toContain("exec_shell");
    expect(html).toContain('aria-label="Done"');
  });

  it("hides system stream blocks", () => {
    const html = render({
      defaultExpanded: true,
      blocks: [
        {
          trace_id: "tr_4",
          seq: 1,
          created_at: "2026-05-25T00:00:00.000Z",
          block: {
            kind: "system",
            payload: { details: "{\"event\":\"turn.started\"}" },
            raw: { event: "turn.started" },
          },
        },
        toolCallBlock({ traceId: "tr_4", seq: 2, createdAt: "2026-05-25T00:00:01.000Z", name: "exec_shell" }),
      ],
    });

    expect(html).not.toContain("turn.started");
    expect(html).toContain("exec_shell");
  });

  it("folds the oldest steps by timestamp behind an earlier-steps link", () => {
    const blocks: StreamBlockEntry[] = [
      toolCallBlock({ seq: 999, createdAt: "2026-05-25T00:00:00.000Z", name: "oldest_by_time" }),
    ];
    for (let i = 1; i <= 8; i += 1) {
      blocks.push(toolCallBlock({
        seq: i,
        createdAt: `2026-05-25T00:00:${String(i).padStart(2, "0")}.000Z`,
        name: `newer_tool_${i}`,
      }));
    }

    const html = render({ defaultExpanded: true, blocks });

    expect(html).not.toContain("Max");
    expect(html).toContain("Show 1 earlier step");
    expect(html).not.toContain("oldest_by_time");
    expect(html).toContain("newer_tool_1");
    expect(html).toContain("newer_tool_8");
  });
});
