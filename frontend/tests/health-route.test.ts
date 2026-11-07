import { describe, expect, it } from "vitest";

import { GET, dynamic } from "@/app/api/health/route";

describe("frontend health route", () => {
  it("returns an uncached process-liveness response", async () => {
    const response = await GET();

    expect(dynamic).toBe("force-dynamic");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      status: "ok",
      service: "botcord-web",
    });
  });
});
