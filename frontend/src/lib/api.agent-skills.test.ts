/**
 * [INPUT]: vitest mock Supabase session + global.fetch
 * [OUTPUT]: userApi agent skills client contract tests
 * [POS]: frontend/lib API guard for Bot Settings Skills tab endpoints
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

process.env.NEXT_PUBLIC_HUB_BASE_URL = "https://api.example.test";

describe("userApi agent skills", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ agent_id: "ag_1", skills: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("loads the snapshotted skill list for an agent", async () => {
    const { userApi } = await import("./api");
    await userApi.listAgentSkills("ag_1");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.example.test/api/agents/ag_1/runtime-skills");
    expect(init.method).toBeUndefined();
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer test-access-token");
  });

  it("requests a daemon skill re-sniff for an agent", async () => {
    const { userApi } = await import("./api");
    await userApi.refreshAgentSkills("ag_1");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.example.test/api/agents/ag_1/runtime-skills/refresh");
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer test-access-token");
  });
});
