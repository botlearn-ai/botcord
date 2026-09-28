import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import ChatMarkdown from "./ChatMarkdown";

describe("shared chat mention rendering", () => {
  it("uses the regular clickable highlight for humans and bots without showing IDs", () => {
    const html = renderToStaticMarkup(<ChatMarkdown content="@Alice(hu_alice) @Helper(ag_helper)" />);
    expect(html).toContain('data-mention-id="hu_alice"');
    expect(html).toContain('data-mention-id="ag_helper"');
    expect(html).toContain("text-neon-cyan underline");
    expect(html).not.toContain("(hu_alice)");
    expect(html).not.toContain("(ag_helper)");
  });
  it("links room references to the existing room route", () => {
    const html = renderToStaticMarkup(<ChatMarkdown content="@Design Team(rm_design)" />);
    expect(html).toContain('href="/chats/messages/rm_design"');
    expect(html).toContain("@Design Team");
    expect(html).not.toContain("(rm_design)");
  });
  it("highlights plain known names and @all in room messages, including Chinese punctuation", () => {
    const html = renderToStaticMarkup(<ChatMarkdown content="你好，@Alice。 @all 请看" mentionCandidates={[{ id: "hu_alice", label: "Alice" }, { id: "@all", label: "all" }]} />);
    expect(html).toContain('data-mention-id="hu_alice"');
    expect(html).toContain('data-mention-id="@all"');
  });
  it("does not turn code or an unknown plain name into a clickable mention", () => {
    const html = renderToStaticMarkup(<ChatMarkdown content={'`@Alice(hu_alice)` @Unknown'} />);
    expect(html).not.toContain('data-mention-id=');
  });
});
