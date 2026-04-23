import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  pollDeviceToken,
  requestDeviceCode,
} from "@botcord/protocol-core";

const HUB = "http://localhost:9000";

describe("requestDeviceCode", () => {
  let originalFetch: typeof fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("parses snake_case fields and applies defaults", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          device_code: "dc_abc",
          user_code: "ABCD-EFGH",
          verification_uri: "https://app.botcord.dev/activate",
          expires_in: 600,
          interval: 5,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    ) as unknown as typeof fetch;

    const dc = await requestDeviceCode(HUB);
    expect(dc.deviceCode).toBe("dc_abc");
    expect(dc.userCode).toBe("ABCD-EFGH");
    expect(dc.expiresIn).toBe(600);
    expect(dc.interval).toBe(5);
  });

  it("forwards label in the request body when provided", async () => {
    let captured: { url: string; init: RequestInit | undefined } | null = null;
    globalThis.fetch = vi.fn(async (url: unknown, init: unknown) => {
      captured = { url: String(url), init: init as RequestInit | undefined };
      return new Response(
        JSON.stringify({
          device_code: "dc_x",
          user_code: "XXXX-YYYY",
          verification_uri: "https://app.botcord.dev/activate",
          expires_in: 600,
          interval: 5,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    await requestDeviceCode(HUB, { label: "MacBook Pro" });
    expect(captured).not.toBeNull();
    const cap = captured as unknown as { url: string; init: { body?: string } };
    const body = JSON.parse(cap.init.body as string) as { label?: string };
    expect(body.label).toBe("MacBook Pro");
  });

  it("throws on missing fields", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({}), { status: 200 }),
    ) as unknown as typeof fetch;
    await expect(requestDeviceCode(HUB)).rejects.toThrow(/missing/);
  });
});

describe("pollDeviceToken", () => {
  let originalFetch: typeof fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns pending on a 200 envelope with status=pending", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ status: "pending" }), { status: 200 }),
    ) as unknown as typeof fetch;
    const r = await pollDeviceToken(HUB, "dc_x");
    expect(r.status).toBe("pending");
  });

  it("translates 4xx authorization_pending into pending", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: "authorization_pending" }), { status: 400 }),
    ) as unknown as typeof fetch;
    const r = await pollDeviceToken(HUB, "dc_x");
    expect(r.status).toBe("pending");
  });

  it("returns slow_down with the suggested interval", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ status: "slow_down", interval: 12 }), {
        status: 200,
      }),
    ) as unknown as typeof fetch;
    const r = await pollDeviceToken(HUB, "dc_x");
    expect(r.status).toBe("slow_down");
    if (r.status === "slow_down") expect(r.interval).toBe(12);
  });

  it("returns the issued token envelope", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          status: "issued",
          access_token: "at_1",
          refresh_token: "rt_1",
          expires_in: 3600,
          user_id: "usr_1",
          daemon_instance_id: "dm_1",
          hub_url: HUB,
        }),
        { status: 200 },
      ),
    ) as unknown as typeof fetch;
    const r = await pollDeviceToken(HUB, "dc_x");
    expect(r.status).toBe("issued");
    if (r.status === "issued") {
      expect(r.accessToken).toBe("at_1");
      expect(r.refreshToken).toBe("rt_1");
      expect(r.userId).toBe("usr_1");
      expect(r.daemonInstanceId).toBe("dm_1");
    }
  });

  it("throws on unrecognized 4xx errors", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: "expired_token" }), { status: 400 }),
    ) as unknown as typeof fetch;
    await expect(pollDeviceToken(HUB, "dc_x")).rejects.toThrow(/expired_token/);
  });

  it("forwards label on poll requests", async () => {
    let body: { label?: string; device_code?: string } | null = null;
    globalThis.fetch = vi.fn(async (_url: unknown, init: unknown) => {
      body = JSON.parse((init as { body: string }).body) as {
        label?: string;
        device_code?: string;
      };
      return new Response(JSON.stringify({ status: "pending" }), { status: 200 });
    }) as unknown as typeof fetch;
    await pollDeviceToken(HUB, "dc_x", { label: "Studio" });
    const cap = body as unknown as { label?: string; device_code?: string };
    expect(cap.label).toBe("Studio");
    expect(cap.device_code).toBe("dc_x");
  });
});
