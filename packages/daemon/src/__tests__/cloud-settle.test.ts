import { describe, expect, it, vi } from "vitest";
import { buildCloudRunSettleHook, postCloudRunSettle } from "../cloud-settle.js";

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function makeFakeFetch(
  response: { status: number; body?: unknown } = { status: 200, body: { ok: true } },
): { fetchFn: typeof fetch; calls: CapturedRequest[] } {
  const calls: CapturedRequest[] = [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({
      url: String(url),
      method: init?.method ?? "GET",
      headers: Object.fromEntries(
        Object.entries(init?.headers ?? {}).map(([k, v]) => [k, String(v)]),
      ),
      body,
    });
    return new Response(
      response.body !== undefined ? JSON.stringify(response.body) : "",
      {
        status: response.status,
        headers: { "Content-Type": "application/json" },
      },
    );
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

describe("postCloudRunSettle", () => {
  it("POSTs the expected body to the settle endpoint", async () => {
    const { fetchFn, calls } = makeFakeFetch();
    const result = await postCloudRunSettle({
      hubUrl: "https://api.botcord.chat",
      accessToken: "tok_jwt_xxx",
      runId: "crun_abc123",
      provider: "deepseek",
      model: "deepseek-chat",
      inputCacheHitTokens: 100,
      inputCacheMissTokens: 50,
      outputTokens: 200,
      sandboxSeconds: 42,
      fetchFn,
    });
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe(
      "https://api.botcord.chat/internal/cloud-agents/runs/crun_abc123/settle",
    );
    expect(call.method).toBe("POST");
    expect(call.headers.Authorization).toBe("Bearer tok_jwt_xxx");
    expect(call.headers["Content-Type"]).toBe("application/json");
    expect(call.body).toEqual({
      provider: "deepseek",
      model: "deepseek-chat",
      input_cache_hit_tokens: 100,
      input_cache_miss_tokens: 50,
      output_tokens: 200,
      sandbox_seconds: 42,
      idempotency_key: "crun_abc123:settle",
    });
  });

  it("uses the supplied idempotency_key when provided", async () => {
    const { fetchFn, calls } = makeFakeFetch();
    await postCloudRunSettle({
      hubUrl: "https://api.botcord.chat",
      accessToken: "tok_x",
      runId: "crun_x",
      provider: "deepseek",
      model: "deepseek-chat",
      inputCacheHitTokens: 0,
      inputCacheMissTokens: 0,
      outputTokens: 0,
      sandboxSeconds: 0,
      idempotencyKey: "custom-key-1",
      fetchFn,
    });
    expect((calls[0]!.body as { idempotency_key: string }).idempotency_key).toBe(
      "custom-key-1",
    );
  });

  it("floors negative or fractional usage numbers", async () => {
    const { fetchFn, calls } = makeFakeFetch();
    await postCloudRunSettle({
      hubUrl: "https://api.botcord.chat",
      accessToken: "tok_x",
      runId: "crun_x",
      provider: "deepseek",
      model: "deepseek-chat",
      inputCacheHitTokens: -5,
      inputCacheMissTokens: 1.9,
      outputTokens: 100.5,
      sandboxSeconds: 10.4,
      fetchFn,
    });
    const body = calls[0]!.body as Record<string, number>;
    expect(body.input_cache_hit_tokens).toBe(0);
    expect(body.input_cache_miss_tokens).toBe(1);
    expect(body.output_tokens).toBe(100);
    expect(body.sandbox_seconds).toBe(10);
  });

  it("returns ok=false on non-2xx without throwing", async () => {
    const { fetchFn } = makeFakeFetch({
      status: 401,
      body: { detail: "unauthorized" },
    });
    const result = await postCloudRunSettle({
      hubUrl: "https://api.botcord.chat",
      accessToken: "bad",
      runId: "crun_x",
      provider: "deepseek",
      model: "deepseek-chat",
      inputCacheHitTokens: 0,
      inputCacheMissTokens: 0,
      outputTokens: 0,
      sandboxSeconds: 0,
      fetchFn,
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
    expect(result.body).toEqual({ detail: "unauthorized" });
  });

  it("URL-encodes the run id (defensive — Hub uses crun_ prefix today)", async () => {
    const { fetchFn, calls } = makeFakeFetch();
    await postCloudRunSettle({
      hubUrl: "https://api.botcord.chat",
      accessToken: "t",
      runId: "crun_abc/../etc",
      provider: "deepseek",
      model: "deepseek-chat",
      inputCacheHitTokens: 0,
      inputCacheMissTokens: 0,
      outputTokens: 0,
      sandboxSeconds: 0,
      fetchFn,
    });
    expect(calls[0]!.url).toContain("crun_abc%2F..%2Fetc");
  });
});


describe("buildCloudRunSettleHook", () => {
  function makeLogger() {
    return {
      info: vi.fn(),
      warn: vi.fn(),
    };
  }

  it("skips non-cloud_run envelopes", async () => {
    const { fetchFn, calls } = makeFakeFetch();
    const hook = buildCloudRunSettleHook({
      hubUrl: "http://localhost:9000",
      accessToken: "tok",
      fetchFn,
    });
    await hook({
      envelopeType: "message",
      runId: "crun_skipme",
      wallTimeMs: 1000,
    });
    expect(calls).toEqual([]);
  });

  it("warns and skips when run_id is missing", async () => {
    const { fetchFn, calls } = makeFakeFetch();
    const log = makeLogger();
    const hook = buildCloudRunSettleHook({
      hubUrl: "http://localhost:9000",
      accessToken: "tok",
      fetchFn,
      log,
    });
    await hook({
      envelopeType: "cloud_run",
      wallTimeMs: 1000,
      messageId: "h_xyz",
    });
    expect(calls).toEqual([]);
    expect(log.warn).toHaveBeenCalledWith(
      "cloud_run envelope missing run_id; skipping settle",
      expect.objectContaining({ messageId: "h_xyz" }),
    );
  });

  it("POSTs settle with sandbox_seconds rounded from wallTimeMs", async () => {
    const { fetchFn, calls } = makeFakeFetch();
    const log = makeLogger();
    const hook = buildCloudRunSettleHook({
      hubUrl: "http://localhost:9000",
      accessToken: "tok_xyz",
      fetchFn,
      log,
    });
    await hook({
      envelopeType: "cloud_run",
      runId: "crun_happy",
      wallTimeMs: 45_321,
      tokens: { outputTokens: 800 },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain("/internal/cloud-agents/runs/crun_happy/settle");
    expect(calls[0]!.headers.Authorization).toBe("Bearer tok_xyz");
    expect(calls[0]!.body).toMatchObject({
      provider: "deepseek",
      model: "deepseek-v4-flash",
      output_tokens: 800,
      sandbox_seconds: 45,
      idempotency_key: "crun_happy:settle",
    });
    expect(log.info).toHaveBeenCalledWith(
      "cloud_run settled",
      expect.objectContaining({ runId: "crun_happy", sandboxSeconds: 45 }),
    );
  });

  it("floors sandbox_seconds at 1 even for sub-second runs", async () => {
    const { fetchFn, calls } = makeFakeFetch();
    const hook = buildCloudRunSettleHook({
      hubUrl: "http://localhost:9000",
      accessToken: "tok",
      fetchFn,
    });
    await hook({
      envelopeType: "cloud_run",
      runId: "crun_quick",
      wallTimeMs: 12,
    });
    expect(calls[0]!.body).toMatchObject({ sandbox_seconds: 1 });
  });

  it("warns on non-2xx settle responses without throwing", async () => {
    const { fetchFn } = makeFakeFetch({ status: 409, body: { code: "x" } });
    const log = makeLogger();
    const hook = buildCloudRunSettleHook({
      hubUrl: "http://localhost:9000",
      accessToken: "tok",
      fetchFn,
      log,
    });
    await hook({
      envelopeType: "cloud_run",
      runId: "crun_409",
      wallTimeMs: 1000,
    });
    expect(log.warn).toHaveBeenCalledWith(
      "cloud_run settle returned non-2xx",
      expect.objectContaining({ runId: "crun_409", status: 409 }),
    );
  });

  it("warns on transport errors without throwing", async () => {
    const fetchFn = (async () => {
      throw new TypeError("connect ECONNREFUSED");
    }) as unknown as typeof fetch;
    const log = makeLogger();
    const hook = buildCloudRunSettleHook({
      hubUrl: "http://localhost:9000",
      accessToken: "tok",
      fetchFn,
      log,
    });
    await expect(
      hook({
        envelopeType: "cloud_run",
        runId: "crun_dead",
        wallTimeMs: 1000,
      }),
    ).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalledWith(
      "cloud_run settle threw — continuing",
      expect.objectContaining({ runId: "crun_dead" }),
    );
  });
});
