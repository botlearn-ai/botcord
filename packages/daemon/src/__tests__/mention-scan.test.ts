import { describe, expect, it } from "vitest";
import { applyLocalMention, scanMention } from "../mention-scan.js";

describe("scanMention", () => {
  it("matches the exact agent id in structured @Name(agentId) mentions", () => {
    expect(
      scanMention("@Harry(ag_973dfb9193eb) 今天的AI日报发一下呢", {
        agentId: "ag_973dfb9193eb",
      })
    ).toBe(true);
  });

  it("still matches display-name mentions", () => {
    expect(
      scanMention("@Harry 今天的AI日报发一下呢", { displayName: "Harry" })
    ).toBe(true);
  });

  it("mutates inbound messages for display-name local mention fallback", () => {
    const msg = {
      accountId: "ag_harry",
      mentioned: false,
      text: "@Harry please review this",
    };
    expect(
      applyLocalMention(msg, { agentId: "ag_harry", displayName: "Harry" })
    ).toBe(true);
    expect(msg.mentioned).toBe(true);
  });

  it("mutates inbound messages for agent-id mentions in raw batches", () => {
    const msg = {
      accountId: "ag_harry",
      mentioned: false,
      text: "latest representative message",
      raw: {
        batch: [
          { text: "@ag_harry please review this" },
          { text: "latest representative message" },
        ],
      },
    };

    expect(
      applyLocalMention(msg, { agentId: "ag_harry", displayName: "Harry" })
    ).toBe(true);
    expect(msg.mentioned).toBe(true);
    expect(msg.raw.batch[0].mentioned).toBe(true);
    expect(msg.raw.batch[1].mentioned).toBeUndefined();
  });

  it("marks matching raw batch entries even when top-level text also mentions", () => {
    const msg = {
      accountId: "ag_harry",
      mentioned: false,
      text: "@Harry latest representative mention",
      raw: {
        batch: [
          { text: "@ag_harry earlier explicit request" },
          { text: "@Harry latest representative mention" },
        ],
      },
    };

    expect(
      applyLocalMention(msg, { agentId: "ag_harry", displayName: "Harry" })
    ).toBe(true);
    expect(msg.mentioned).toBe(true);
    expect(msg.raw.batch[0].mentioned).toBe(true);
    expect(msg.raw.batch[1].mentioned).toBe(true);
  });

  it("mutates inbound messages for display-name mentions in raw batch envelopes", () => {
    const msg = {
      accountId: "ag_harry",
      mentioned: false,
      text: "latest representative message",
      raw: {
        batch: [
          { envelope: { payload: { text: "@Harry please verify this" } } },
          { text: "latest representative message" },
        ],
      },
    };

    expect(
      applyLocalMention(msg, { agentId: "ag_harry", displayName: "Harry" })
    ).toBe(true);
    expect(msg.mentioned).toBe(true);
    expect(msg.raw.batch[0].mentioned).toBe(true);
    expect(msg.raw.batch[1].mentioned).toBeUndefined();
  });

  it("does not mutate inbound messages for unrelated raw batch mentions", () => {
    const msg = {
      accountId: "ag_harry",
      mentioned: false,
      text: "latest representative message",
      raw: {
        batch: [{ text: "@Other please review this" }],
      },
    };

    expect(
      applyLocalMention(msg, { agentId: "ag_harry", displayName: "Harry" })
    ).toBe(false);
    expect(msg.mentioned).toBe(false);
  });
});
