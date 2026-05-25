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
  it("does not render composing text for delivered execution blocks by default", () => {
    const html = renderToStaticMarkup(
      React.createElement(StreamBlocksView, { blocks: [mixedToolUseBlock()] }),
    );

    expect(html).not.toContain("Composing");
    expect(html).not.toContain("draft answer");
  });

  it("renders composing text when explicitly used for an active stream", () => {
    const html = renderToStaticMarkup(
      React.createElement(StreamBlocksView, { blocks: [mixedToolUseBlock()], showComposing: true }),
    );

    expect(html).toContain("Composing");
    expect(html).toContain("draft answer");
  });
});
