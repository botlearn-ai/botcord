/**
 * [INPUT]: vitest mock Supabase session + global.fetch
 * [OUTPUT]: api activity stats batch client contract tests
 * [POS]: frontend/lib API guard for dashboard activity stats batching
 * [PROTOCOL]: update header on changes
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    auth: {
      getSession: async () => ({
        data: { session: { access_token: "test-access-token" } },
      }),
    },
  }),
}));

function toUrl(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

describe("api.getActivityStatsBatch", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    process.env.NEXT_PUBLIC_HUB_BASE_URL = "https://api.example.test";
    vi.resetModules();
    fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(toUrl(input));
      const agentIds = url.searchParams.get("agent_ids")?.split(",").filter(Boolean) ?? [];
      const stats = Object.fromEntries(
        agentIds.map((agentId) => [
          agentId,
          {
            messages_sent: Number(agentId.replace("ag_", "")),
            messages_received: 0,
            topics_open: 0,
            topics_completed: 0,
            active_rooms: 0,
          },
        ]),
      );

      return new Response(JSON.stringify({ stats }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("splits requests into backend-sized batches and merges the stats", async () => {
    const { api } = await import("./api");
    const agentIds = Array.from({ length: 25 }, (_, index) =>
      `ag_${String(index + 1).padStart(2, "0")}`,
    );

    const result = await api.getActivityStatsBatch(agentIds, "7d");

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const urls = fetchMock.mock.calls.map(([input]) => new URL(toUrl(input as string | URL | Request)));
    expect(urls.map((url) => url.searchParams.get("period"))).toEqual(["7d", "7d", "7d"]);
    expect(urls.map((url) => url.searchParams.get("agent_ids")?.split(","))).toEqual([
      agentIds.slice(0, 12),
      agentIds.slice(12, 24),
      agentIds.slice(24),
    ]);
    expect(new Headers((fetchMock.mock.calls[0][1] as RequestInit).headers).get("Authorization")).toBe(
      "Bearer test-access-token",
    );
    expect(Object.keys(result.stats)).toEqual(agentIds);
    expect(result.stats.ag_25.messages_sent).toBe(25);
  });

  it("returns an empty stats map without issuing a backend request", async () => {
    const { api } = await import("./api");

    await expect(api.getActivityStatsBatch(["", "  "], "7d")).resolves.toEqual({ stats: {} });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
