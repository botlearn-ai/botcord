import { describe, expect, it } from "vitest";
import { detectMention, insertMentionTrigger } from "./composer-mentions";

describe("mention queries", () => {
  it.each(["@", "你好，@", "你好\n@", "（@", "＠"])("opens suggestions after %s", (text) => {
    expect(detectMention(text, text.length)).toEqual({ start: text.length - 1, query: "" });
  });
  it("searches Chinese names and full-width triggers", () => {
    expect(detectMention("你好，＠小明", 6)).toEqual({ start: 3, query: "小明" });
  });
  it("uses the caret instead of the end of the draft", () => {
    expect(detectMention("@Alice later", 3)).toEqual({ start: 0, query: "Al" });
  });
  it.each(["mail@example.com", "@Alice ", "hello", "@Alice\n"])("ignores %s", (text) => {
    expect(detectMention(text, text.length)).toBeNull();
  });
});

describe("mention shortcut", () => {
  it("opens at the caret and preserves the suffix", () => {
    expect(insertMentionTrigger("hello world", 5, 5)).toEqual({ text: "hello @ world", cursor: 7 });
  });
  it("replaces selected text", () => {
    expect(insertMentionTrigger("hello world!", 6, 11)).toEqual({ text: "hello @!", cursor: 7 });
  });
  it("reuses an existing query", () => {
    expect(insertMentionTrigger("@Ali", 4, 4)).toEqual({ text: "@Ali", cursor: 4 });
  });
  it("supports an empty draft", () => {
    expect(insertMentionTrigger("", 0, 0)).toEqual({ text: "@", cursor: 1 });
  });
});

import { hydrateMentionDraft, reconcileDraftMentions, serializeDraftMentions, type DraftMention } from "./composer-mentions";

describe("selected mention identities", () => {
  const alice: DraftMention = { start: 0, end: 6, display_name: "Alice", agent_id: "hu_a", id: "hu_a" };
  it("keeps IDs out of the editor and restores the wire format", () => {
    expect(serializeDraftMentions("@Alice hello", [alice])).toBe("@Alice(hu_a) hello");
  });
  it("moves ranges when text is inserted before a selection", () => {
    const moved = reconcileDraftMentions("@Alice hello", "Hi @Alice hello", [alice]);
    expect(serializeDraftMentions("Hi @Alice hello", moved)).toBe("Hi @Alice(hu_a) hello");
  });
  it.each(["@Alic hello", "@AliceX hello", "hello", "x@Alice hello"])("removes identity when editing the name: %s", (after) => {
    expect(reconcileDraftMentions("@Alice hello", after, [alice])).toEqual([]);
  });
  it("retains identity next to Chinese punctuation", () => {
    expect(reconcileDraftMentions("@Alice hello", "@Alice，你好", [alice])).toEqual([alice]);
  });
  it("keeps separate identities for two people with the same name", () => {
    const other = { ...alice, start: 7, end: 13, agent_id: "hu_b", id: "hu_b" };
    expect(serializeDraftMentions("@Alice @Alice ", [alice, other])).toBe("@Alice(hu_a) @Alice(hu_b) ");
  });
  it("does not turn newly typed text into a selected identity", () => {
    expect(reconcileDraftMentions("", "@Alice ", [])).toEqual([]);
  });
});


it("hydrates forwarded drafts without exposing IDs and round-trips the original wire text", () => {
  const wire = "引用 @Alice(hu_a) 和 @Team(rm_team) 的消息";
  const draft = hydrateMentionDraft(wire);
  expect(draft.text).toBe("引用 @Alice 和 @Team 的消息");
  expect(serializeDraftMentions(draft.text, draft.mentions)).toBe(wire);
});

it("preserves the intended identity when deleting the first of two identical labels", () => {
  const first = { start: 0, end: 6, display_name: "Alice", agent_id: "hu_a", id: "hu_a" };
  const second = { ...first, start: 7, end: 13, agent_id: "hu_b", id: "hu_b" };
  const next = reconcileDraftMentions("@Alice @Alice ", "@Alice ", [first, second], { start: 0, end: 7 });
  expect(serializeDraftMentions("@Alice ", next)).toBe("@Alice(hu_b) ");
});
