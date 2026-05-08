import { describe, expect, it } from "vitest";
import { splitPlainMentionText } from "./MarkdownContent";

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
