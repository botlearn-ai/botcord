import { describe, expect, it } from "vitest";
import {
  isPreviewableMarkdownImageSrc,
  normalizeMessageContent,
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
