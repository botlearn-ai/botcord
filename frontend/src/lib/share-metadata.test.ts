import { afterEach, describe, expect, it, vi } from "vitest";
import { getAppBaseUrl, getShareMetadataData } from "./share-metadata";

const sharedRoomResponse = {
  share_id: "shr_test",
  shared_by: "Alice",
  shared_at: "2026-11-06T00:00:00Z",
  entry_type: "room",
  room: {
    name: "Internal room",
    description: "Shared through the Hub",
    member_count: 2,
  },
  messages: [{ id: "msg_1" }],
};

describe("share metadata service routing", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("fetches metadata through the internal Hub without changing the public app URL", async () => {
    vi.stubEnv("HUB_INTERNAL_URL", "http://botcord-backend:8000/");
    vi.stubEnv("NEXT_PUBLIC_HUB_BASE_URL", "https://api.example.test");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://app.example.test/");
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify(sharedRoomResponse), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(getShareMetadataData("shr_test")).resolves.toMatchObject({
      shareId: "shr_test",
      roomName: "Internal room",
      messageCount: 1,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://botcord-backend:8000/api/share/shr_test",
      { next: { revalidate: 300 } },
    );
    expect(getAppBaseUrl()).toBe("https://app.example.test");
    expect(process.env.NEXT_PUBLIC_HUB_BASE_URL).toBe("https://api.example.test");
  });

  it("preserves the public Hub fallback when no internal route is configured", async () => {
    vi.stubEnv("HUB_INTERNAL_URL", "");
    vi.stubEnv("NEXT_PUBLIC_HUB_BASE_URL", "https://api.example.test/");
    const fetchMock = vi.fn(async () => new Response("not found", { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getShareMetadataData("shr_test")).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.test/api/share/shr_test",
      { next: { revalidate: 300 } },
    );
  });
});
