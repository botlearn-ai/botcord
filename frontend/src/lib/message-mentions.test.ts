import { describe, expect, it } from "vitest";
import {
  normalizeMessageMentions,
  resolveMessageMentionTargets,
} from "./message-mentions";

describe("normalizeMessageMentions", () => {
  it("keeps unique non-empty mention ids", () => {
    expect(normalizeMessageMentions(["ag_a", "", " ag_b ", "ag_a", 123])).toEqual(["ag_a", "ag_b"]);
  });
});

describe("resolveMessageMentionTargets", () => {
  const candidates = [
    { id: "ag_harry", label: "Harry" },
    { id: "hu_alice", label: "Alice Zhang" },
  ];

  it("returns display labels for metadata mentions missing from the body", () => {
    expect(resolveMessageMentionTargets(["ag_harry", "hu_alice"], candidates, "帮我看一下这个方案")).toEqual([
      { id: "ag_harry", label: "Harry" },
      { id: "hu_alice", label: "Alice Zhang" },
    ]);
  });

  it("does not duplicate mentions already visible in plain text", () => {
    expect(resolveMessageMentionTargets(["ag_harry"], candidates, "@Harry 帮我看一下")).toEqual([]);
  });

  it("does not duplicate mentions already visible in structured text", () => {
    expect(resolveMessageMentionTargets(["ag_harry"], candidates, "@Harry(ag_harry) 帮我看一下")).toEqual([]);
  });

  it("supports @all metadata", () => {
    expect(resolveMessageMentionTargets(["@all"], candidates, "大家看一下")).toEqual([
      { id: "@all", label: "all" },
    ]);
    expect(resolveMessageMentionTargets(["@all"], candidates, "@all 大家看一下")).toEqual([]);
  });
});
