import { describe, expect, it, vi, beforeEach } from "vitest";
import { BotCordClient } from "../client.js";

// Capture the path passed to hubFetch
let capturedPath: string;

vi.mock("../runtime.js", () => ({
  getBotCordRuntime: vi.fn(() => ({})),
  getConfig: vi.fn(() => null),
}));

describe("BotCordClient.request() query serialization", () => {
  let client: BotCordClient;

  beforeEach(() => {
    client = new BotCordClient({
      hubUrl: "https://hub.test",
      agentId: "ag_test",
      keyId: "k_test",
      privateKey: "deadbeef",
    } as any);

    // Stub hubFetch to capture the path
    (client as any).hubFetch = vi.fn(async (path: string, _init: RequestInit) => {
      capturedPath = path;
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ ok: true }),
      };
    });
  });

  it("serializes repeated query parameters", async () => {
    await client.request("GET", "/hub/search", {
      query: { q: ["deploy", "release"] as any },
    });
    // Should produce q=deploy&q=release, not q=deploy%2Crelease
    expect(capturedPath).toBe("/hub/search?q=deploy&q=release");
  });

  it("serializes single string query parameters", async () => {
    await client.request("GET", "/hub/rooms", {
      query: { limit: "10", offset: "0" },
    });
    expect(capturedPath).toBe("/hub/rooms?limit=10&offset=0");
  });

  it("merges query params when path already has a query string", async () => {
    await client.request("GET", "/hub/rooms?type=public", {
      query: { limit: "10" },
    });
    // Should use & separator, not ?
    expect(capturedPath).toBe("/hub/rooms?type=public&limit=10");
  });

  it("handles no query params", async () => {
    await client.request("GET", "/hub/inbox");
    expect(capturedPath).toBe("/hub/inbox");
  });
});
