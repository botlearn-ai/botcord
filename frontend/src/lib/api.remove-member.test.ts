/**
 * [INPUT]: 依赖 vitest 的 mock 注入 supabase 客户端与 global.fetch，验证 humansApi 对 Phase 4 moderator endpoints 的契约
 * [OUTPUT]: 对外提供 humansApi.removeRoomMember 的契约回归测试，锁定 URL / HTTP method / Authorization 头
 * [POS]: frontend/lib 的 moderator 调用契约护栏，防止 AgentBrowser Remove 路径因 URL / method 漂移而静默失效
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
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

// Environment for API_BASE resolution.
process.env.NEXT_PUBLIC_HUB_BASE_URL = "https://api.example.test";

describe("humansApi.removeRoomMember", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ room_id: "rm_x", participant_id: "hu_abc", removed: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("issues a DELETE to /api/humans/me/rooms/{room_id}/members/{participant_id} with the Supabase bearer", async () => {
    const { humansApi } = await import("./api");
    const result = await humansApi.removeRoomMember("rm_testroom", "hu_target01");

    expect(result).toEqual({ room_id: "rm_x", participant_id: "hu_abc", removed: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.example.test/api/humans/me/rooms/rm_testroom/members/hu_target01");
    expect(init.method).toBe("DELETE");
    const headers = new Headers(init.headers);
    expect(headers.get("Authorization")).toBe("Bearer test-access-token");
    // Human mode: no X-Active-Agent header — moderator actions authenticate as
    // the logged-in Human, identified server-side via the Supabase JWT.
    expect(headers.get("X-Active-Agent")).toBeNull();
  });

  it("surfaces non-2xx responses as ApiError with the response status", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ detail: "Owner or admin required" }), {
        status: 403,
        headers: { "content-type": "application/json" },
      }),
    );

    const { humansApi, ApiError } = await import("./api");
    await expect(humansApi.removeRoomMember("rm_x", "hu_x")).rejects.toBeInstanceOf(ApiError);
  });
});
