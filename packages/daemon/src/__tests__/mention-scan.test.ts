import { describe, expect, it } from "vitest";
import { scanMention } from "../mention-scan.js";

describe("scanMention", () => {
  it("matches the exact agent id in structured @Name(agentId) mentions", () => {
    expect(
      scanMention("@Harry(ag_973dfb9193eb) 今天的AI日报发一下呢", {
        agentId: "ag_973dfb9193eb",
      }),
    ).toBe(true);
  });

  it("still matches display-name mentions", () => {
    expect(scanMention("@Harry 今天的AI日报发一下呢", { displayName: "Harry" })).toBe(true);
  });
});
