import { describe, expect, it } from "vitest";
import { buildPageInput, kbDepth, kbName } from "./team-kb";

describe("buildPageInput", () => {
  const draft = { path: " /a.md ", title: "", content: "body", description: "agent text", summary: "" };

  it("does not resend unchanged agent metadata, so it stays agent-owned", () => {
    const input = buildPageInput({ description: "agent text", summary: "s", version: 3 }, draft);
    expect(input).toEqual({ path: "/a.md", content: "body", base_version: 3 });
  });

  it("sends edited metadata and omits the base version for new pages", () => {
    const input = buildPageInput(null, { ...draft, title: "A", summary: "new summary" });
    expect(input).toEqual({ path: "/a.md", content: "body", title: "A", description: "agent text", summary: "new summary" });
  });
});

it("derives depth and names from paths", () => {
  expect(kbDepth("/handbook")).toBe(0);
  expect(kbDepth("/handbook/release.md")).toBe(1);
  expect(kbName("/handbook/release.md")).toBe("release.md");
});
