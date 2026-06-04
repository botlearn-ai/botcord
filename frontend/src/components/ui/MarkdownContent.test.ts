import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import MarkdownContent, {
  hasFailedMarkdownImageSrc,
  isPreviewableMarkdownImageSrc,
  normalizeMessageContent,
  rememberFailedMarkdownImageSrc,
  splitPlainMentionText,
} from "./MarkdownContent";

function mentionProps(node: unknown) {
  return (node as { properties?: Record<string, unknown> }).properties;
}

describe("splitPlainMentionText", () => {
  it("resolves plain display-name mentions with spaces and apostrophes", () => {
    const nodes = splitPlainMentionText("@Garry's Codex 谢谢", [
      { id: "ag_garry", label: "Garry's Codex" },
    ]);

    expect(nodes).toHaveLength(2);
    expect(mentionProps(nodes[0])?.["data-mention-id"]).toBe("ag_garry");
    expect(mentionProps(nodes[0])?.["data-mention-label"]).toBe("Garry's Codex");
    expect(nodes[1]).toEqual({ type: "text", value: " 谢谢" });
  });

  it("does not resolve @ inside email addresses", () => {
    const nodes = splitPlainMentionText("ping me@example.com", [
      { id: "ag_example", label: "example" },
    ]);

    expect(nodes).toEqual([{ type: "text", value: "ping me@example.com" }]);
  });

  it("prefers the longest matching display name", () => {
    const nodes = splitPlainMentionText("@Garry's Codex hi", [
      { id: "ag_short", label: "Garry" },
      { id: "ag_long", label: "Garry's Codex" },
    ]);

    expect(mentionProps(nodes[0])?.["data-mention-id"]).toBe("ag_long");
  });

  it("highlights bare agent-id mentions even without candidates", () => {
    const nodes = splitPlainMentionText("@ag_17b5d5e1b071 Ops hourly triage");

    expect(mentionProps(nodes[0])?.["data-mention-id"]).toBe("ag_17b5d5e1b071");
    expect(mentionProps(nodes[0])?.["data-mention-label"]).toBe("ag_17b5d5e1b071");
    expect(nodes[1]).toEqual({ type: "text", value: " Ops hourly triage" });
  });

  it("highlights bare human-id mentions and respects end boundaries", () => {
    const nodes = splitPlainMentionText("cc @hu_0123456789ab, thanks");

    expect(nodes[0]).toEqual({ type: "text", value: "cc " });
    expect(mentionProps(nodes[1])?.["data-mention-id"]).toBe("hu_0123456789ab");
    expect(nodes[2]).toEqual({ type: "text", value: ", thanks" });
  });

  it("does not treat malformed ids (wrong length) as mentions", () => {
    const nodes = splitPlainMentionText("see @ag_17b5d5e1b071beef next");

    expect(nodes).toEqual([{ type: "text", value: "see @ag_17b5d5e1b071beef next" }]);
  });
});

describe("normalizeMessageContent", () => {
  it("converts escaped line breaks from message payloads", () => {
    expect(normalizeMessageContent("line one\\nline two")).toBe("line one\nline two");
    expect(normalizeMessageContent("line one\\r\\nline two")).toBe("line one\nline two");
  });

  it("preserves existing real line breaks", () => {
    expect(normalizeMessageContent("line one\nline two")).toBe("line one\nline two");
  });
});

describe("isPreviewableMarkdownImageSrc", () => {
  it("allows only absolute http(s) image URLs", () => {
    expect(isPreviewableMarkdownImageSrc("https://example.com/card.png")).toBe(true);
    expect(isPreviewableMarkdownImageSrc("http://example.com/card.png")).toBe(true);
    expect(isPreviewableMarkdownImageSrc("output/xhs-01-cover.png")).toBe(false);
    expect(isPreviewableMarkdownImageSrc("social-card-botcord-agent-hub/index.html")).toBe(false);
    expect(isPreviewableMarkdownImageSrc("/hub/files/f_123")).toBe(false);
  });
});

describe("MarkdownContent images", () => {
  it("renders previewable markdown images as zoomable preview buttons", () => {
    const html = renderToStaticMarkup(
      React.createElement(MarkdownContent, {
        content: "![cover](https://example.com/card.png)",
      }),
    );

    expect(html).toContain('aria-label="Preview cover"');
    expect(html).toContain('src="https://example.com/card.png"');
    expect(html).toContain("cursor-zoom-in");
  });
});

describe("failed markdown image tracking", () => {
  it("remembers failed image URLs for the current session", () => {
    const imageUrl = "https://example.com/card-session-failure.png";
    expect(hasFailedMarkdownImageSrc(imageUrl)).toBe(false);

    rememberFailedMarkdownImageSrc(` ${imageUrl} `);

    expect(hasFailedMarkdownImageSrc(imageUrl)).toBe(true);
  });
});
