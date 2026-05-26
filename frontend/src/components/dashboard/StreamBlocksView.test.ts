import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import StreamBlocksView from "./StreamBlocksView";
import type { StreamBlockEntry } from "@/lib/types";

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

describe("StreamBlocksView", () => {
  it("hides composing text when the tool card is collapsed (default)", () => {
    const html = renderToStaticMarkup(
      React.createElement(StreamBlocksView, {
        blocks: [mixedToolUseBlock()],
        showComposing: true,
      }),
    );

    expect(html).not.toContain("Composing");
    expect(html).not.toContain("draft answer");
  });

  it("renders composing text inside the expanded tool card", () => {
    const html = renderToStaticMarkup(
      React.createElement(StreamBlocksView, {
        blocks: [mixedToolUseBlock()],
        showComposing: true,
        defaultExpanded: true,
      }),
    );

    expect(html).toContain("Composing");
    expect(html).toContain("draft answer");
  });

  it("does not render composing text when showComposing is off, even if expanded", () => {
    const html = renderToStaticMarkup(
      React.createElement(StreamBlocksView, {
        blocks: [mixedToolUseBlock()],
        defaultExpanded: true,
      }),
    );

    expect(html).not.toContain("Composing");
    expect(html).not.toContain("draft answer");
  });

  it("falls back to raw tool input when normalized payload is empty", () => {
    const html = renderToStaticMarkup(
      React.createElement(StreamBlocksView, {
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
      }),
    );

    expect(html).toContain("exec_shell");
    expect(html).toContain("botcord-daemon status");
  });

  it("falls back to raw tool output when normalized result is empty", () => {
    const html = renderToStaticMarkup(
      React.createElement(StreamBlocksView, {
        defaultExpanded: true,
        blocks: [{
          trace_id: "tr_3",
          seq: 1,
          created_at: "2026-05-25T00:00:00.000Z",
          block: {
            kind: "tool_result",
            payload: {},
            raw: {
              event: "item.completed",
              payload: {
                item: {
                  id: "item_exec",
                  kind: "tool_call",
                  summary: "exec_shell: daemon: pid 49616",
                  detail: "daemon: pid 49616 (alive)",
                },
              },
            },
          },
        }],
      }),
    );

    expect(html).toContain("exec_shell");
    expect(html).toContain("daemon: pid 49616");
  });
});
