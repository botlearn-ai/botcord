import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BotCordClient,
  resetSharedCredentialStatesForTests,
  type BotCordAuthDiagnostic,
} from "../client.js";

const privateKey = Buffer.alloc(32, 2).toString("base64");

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  resetSharedCredentialStatesForTests();
});

describe("BotCordClient token refresh", () => {
  it("normalizes millisecond tokenExpiresAt config values", () => {
    const client = new BotCordClient({
      hubUrl: "https://hub.example",
      agentId: "ag_test",
      keyId: "k_test",
      privateKey,
      token: "cached-token",
      tokenExpiresAt: 1_779_856_985_546,
    });

    expect(client.getTokenExpiresAt()).toBe(1_779_856_985);
  });

  it("retries a 401 response with the refreshed token", async () => {
    const requests: Array<{ url: string; headers: Record<string, string> }> = [];
    let inboxAttempts = 0;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const headers = (init?.headers ?? {}) as Record<string, string>;
        requests.push({ url, headers });

        if (url === "https://hub.example/hub/inbox?limit=50") {
          inboxAttempts += 1;
          if (inboxAttempts === 1) {
            return new Response("expired", { status: 401 });
          }
          return Response.json({ messages: [], count: 0, has_more: false });
        }

        if (url === "https://hub.example/registry/agents/ag_test/token/refresh") {
          return Response.json({
            agent_token: "new-token",
            expires_at: Math.floor(Date.now() / 1000) + 3600,
          });
        }

        return new Response("not found", { status: 404 });
      }),
    );

    const client = new BotCordClient({
      hubUrl: "https://hub.example",
      agentId: "ag_test",
      keyId: "k_test",
      privateKey,
      token: "old-token",
      tokenExpiresAt: Math.floor(Date.now() / 1000) + 3600,
    });

    await client.pollInbox({ limit: 50 });

    const inboxRequests = requests.filter((req) => req.url === "https://hub.example/hub/inbox?limit=50");
    expect(inboxRequests).toHaveLength(2);
    expect(inboxRequests[0].headers.Authorization).toBe("Bearer old-token");
    expect(inboxRequests[1].headers.Authorization).toBe("Bearer new-token");
    expect(inboxRequests[0].headers).toMatchObject({
      "X-BotCord-Caller": "protocol-core",
      "X-BotCord-Caller-Version": "0.2.17",
      "X-BotCord-Agent-ID": "ag_test",
      "X-BotCord-Credential-Key-ID": "k_test",
    });
    expect(inboxRequests[0].headers["X-BotCord-Request-ID"]).toMatch(/^[0-9a-f]{32}$/);
    expect(inboxRequests[1].headers["X-BotCord-Request-ID"]).toBe(
      inboxRequests[0].headers["X-BotCord-Request-ID"],
    );
    const refreshRequest = requests.find((req) =>
      req.url === "https://hub.example/registry/agents/ag_test/token/refresh"
    );
    expect(refreshRequest?.headers["X-BotCord-Request-ID"]).toBe(
      inboxRequests[0].headers["X-BotCord-Request-ID"],
    );
    expect(refreshRequest?.headers["X-BotCord-Caller-Version"]).toBe("0.2.17");
  });

  it("single-flights concurrent refreshes and shares the new generation across clients", async () => {
    let releaseRefresh!: () => void;
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    let refreshCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).endsWith("/token/refresh")) {
          refreshCount += 1;
          await refreshGate;
          return Response.json({
            agent_token: "shared-new-token",
            expires_at: Math.floor(Date.now() / 1000) + 3600,
          });
        }
        return Response.json({ messages: [], count: 0, has_more: false });
      }),
    );
    const config = {
      hubUrl: "https://hub.concurrent.example",
      agentId: "ag_concurrent",
      keyId: "k_concurrent",
      privateKey,
    };
    const first = new BotCordClient(config);
    const second = new BotCordClient(config);

    const firstRefresh = first.ensureToken();
    const secondRefresh = second.ensureToken();
    releaseRefresh();

    await expect(Promise.all([firstRefresh, secondRefresh])).resolves.toEqual([
      "shared-new-token",
      "shared-new-token",
    ]);
    expect(refreshCount).toBe(1);
    expect(first.getToken()).toBe("shared-new-token");
    expect(second.getToken()).toBe("shared-new-token");
  });

  it("reuses a peer generation when REST 401 recovery races a completed refresh", async () => {
    const authorizations: string[] = [];
    let refreshCount = 0;
    let releaseStaleResponse!: () => void;
    const staleResponseGate = new Promise<void>((resolve) => {
      releaseStaleResponse = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/token/refresh")) {
          refreshCount += 1;
          return Response.json({
            agent_token: "peer-new-token",
            expires_at: Math.floor(Date.now() / 1000) + 3600,
          });
        }
        authorizations.push(((init?.headers ?? {}) as Record<string, string>).Authorization);
        if (authorizations.length === 1) {
          await staleResponseGate;
          return new Response("stale", { status: 401 });
        }
        return Response.json({ messages: [], count: 0, has_more: false });
      }),
    );
    const config = {
      hubUrl: "https://hub.rest-race.example",
      agentId: "ag_rest_race",
      keyId: "k_rest_race",
      privateKey,
      token: "old-token",
      tokenExpiresAt: Math.floor(Date.now() / 1000) + 3600,
    };
    const restClient = new BotCordClient(config);
    const peerClient = new BotCordClient(config);
    const request = restClient.pollInbox();
    await vi.waitFor(() => expect(authorizations).toHaveLength(1));
    await peerClient.refreshToken("old-token");
    releaseStaleResponse();
    await request;

    expect(refreshCount).toBe(1);
    expect(authorizations).toEqual(["Bearer old-token", "Bearer peer-new-token"]);
  });

  it("emits privacy-safe auth generation diagnostics without credential material", async () => {
    const events: BotCordAuthDiagnostic[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          agent_token: "super-secret-token",
          expires_at: Math.floor(Date.now() / 1000) + 3600,
        }),
      ),
    );
    const client = new BotCordClient({
      hubUrl: "https://hub.diagnostics.example",
      agentId: "ag_diagnostics",
      keyId: "k_diagnostics",
      privateKey,
      authDiagnostic: (event) => events.push(event),
    });
    await client.ensureToken();

    expect(events.map((event) => event.event)).toEqual([
      "client_created",
      "refresh_started",
      "refresh_succeeded",
    ]);
    expect(events[2]).toMatchObject({
      generation: 1,
      reason: "missing_or_expiring",
    });
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain("super-secret-token");
    expect(serialized).not.toContain(privateKey);
    expect(serialized).not.toContain("ag_diagnostics");
    expect(serialized).not.toContain("k_diagnostics");
  });

  it("correlates a delayed stale-token 401 with the reused refresh generation", async () => {
    const events: BotCordAuthDiagnostic[] = [];
    let releaseStaleResponse!: () => void;
    const staleResponseGate = new Promise<void>((resolve) => {
      releaseStaleResponse = resolve;
    });
    const authorizations: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/token/refresh")) {
        return Response.json({
          agent_token: "rotated-token",
          expires_at: Math.floor(Date.now() / 1000) + 3600,
        });
      }
      authorizations.push(((init?.headers ?? {}) as Record<string, string>).Authorization);
      if (authorizations.length === 1) {
        await staleResponseGate;
        return new Response("stale", { status: 401 });
      }
      return Response.json({ messages: [], count: 0, has_more: false });
    }));
    const config = {
      hubUrl: "https://hub.delayed-race.example",
      agentId: "ag_delayed_race",
      keyId: "k_delayed_race",
      privateKey,
      token: "old-token",
      tokenExpiresAt: Math.floor(Date.now() / 1000) + 3600,
      authDiagnostic: (event: BotCordAuthDiagnostic) => events.push(event),
    };
    const requestClient = new BotCordClient(config);
    const refreshClient = new BotCordClient(config);
    const request = requestClient.pollInbox();
    await vi.waitFor(() => expect(authorizations).toHaveLength(1));
    await refreshClient.refreshToken("old-token");
    releaseStaleResponse();
    await request;

    const reused = events.find((event) => event.event === "refresh_reused");
    expect(reused).toMatchObject({ reason: "rest_401", generation: 2 });
    expect(reused?.requestId).toMatch(/^[0-9a-f]{32}$/);
    expect(authorizations).toEqual(["Bearer old-token", "Bearer rotated-token"]);
  });

  it("reuses a peer generation when WS invalid_token reports the token used to authenticate", async () => {
    let refreshCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        refreshCount += 1;
        return Response.json({
          agent_token: "peer-ws-token",
          expires_at: Math.floor(Date.now() / 1000) + 3600,
        });
      }),
    );
    const config = {
      hubUrl: "https://hub.ws-race.example",
      agentId: "ag_ws_race",
      keyId: "k_ws_race",
      privateKey,
      token: "ws-auth-token",
      tokenExpiresAt: Math.floor(Date.now() / 1000) + 3600,
    };
    const wsClient = new BotCordClient(config);
    const peerClient = new BotCordClient(config);

    await peerClient.refreshToken("ws-auth-token");
    await expect(wsClient.refreshToken("ws-auth-token")).resolves.toBe("peer-ws-token");
    expect(refreshCount).toBe(1);
  });

  it("attaches status and code to token refresh failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          {
            code: "key_not_found",
            detail: "Key not found",
            retryable: false,
          },
          { status: 404 },
        ),
      ),
    );

    const client = new BotCordClient({
      hubUrl: "https://hub.example",
      agentId: "ag_test",
      keyId: "k_stale",
      privateKey,
    });

    await expect(client.refreshToken()).rejects.toMatchObject({
      status: 404,
      code: "key_not_found",
    });
  });

  it("keeps one correlation id across 429 retries", async () => {
    vi.useFakeTimers();
    const requestIds: string[] = [];
    let attempts = 0;
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      requestIds.push(headers["X-BotCord-Request-ID"]);
      attempts += 1;
      if (attempts < 3) return new Response("rate limited", { status: 429 });
      return Response.json({ messages: [], count: 0, has_more: false });
    }));
    const client = new BotCordClient({
      hubUrl: "https://hub.example",
      agentId: "ag_test",
      keyId: "k_test",
      privateKey,
      token: "cached-token",
      tokenExpiresAt: Math.floor(Date.now() / 1000) + 3600,
    });

    const poll = client.pollInbox({ limit: 50 });
    await vi.runAllTimersAsync();
    await poll;

    expect(requestIds).toHaveLength(3);
    expect(new Set(requestIds).size).toBe(1);
  });

  it("does not retry a duplicate_content 429", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () =>
      Response.json(
        {
          detail: "Duplicate content",
          code: "duplicate_content",
          retryable: false,
        },
        { status: 429 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new BotCordClient({
      hubUrl: "https://hub.example",
      agentId: "ag_test",
      keyId: "k_test",
      privateKey,
      token: "cached-token",
      tokenExpiresAt: Math.floor(Date.now() / 1000) + 3600,
    });

    await expect(client.sendMessage("rm_1", "duplicate")).rejects.toMatchObject({
      status: 429,
      message: expect.stringContaining("duplicate_content"),
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not blindly retry a send 429 without Retry-After", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () =>
      Response.json(
        { detail: "Rate limit exceeded", code: "rate_limit_exceeded" },
        { status: 429 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new BotCordClient({
      hubUrl: "https://hub.example",
      agentId: "ag_test",
      keyId: "k_test",
      privateKey,
      token: "cached-token",
      tokenExpiresAt: Math.floor(Date.now() / 1000) + 3600,
    });

    await expect(client.sendMessage("rm_1", "rate limited")).rejects.toMatchObject({
      status: 429,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("honors Retry-After and identifies a send retry attempt", async () => {
    vi.useFakeTimers();
    const attempts: string[] = [];
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      attempts.push((init?.headers as Record<string, string>)["X-BotCord-Retry-Attempt"]);
      if (attempts.length === 1) {
        return Response.json(
          { detail: "Rate limit exceeded", code: "rate_limit_exceeded" },
          { status: 429, headers: { "Retry-After": "7" } },
        );
      }
      return Response.json({ hub_msg_id: "hub_1" });
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new BotCordClient({
      hubUrl: "https://hub.example",
      agentId: "ag_test",
      keyId: "k_test",
      privateKey,
      token: "cached-token",
      tokenExpiresAt: Math.floor(Date.now() / 1000) + 3600,
    });

    const send = client.sendMessage("rm_1", "rate limited");
    await vi.advanceTimersByTimeAsync(6999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(send).resolves.toMatchObject({ hub_msg_id: "hub_1" });
    expect(attempts).toEqual(["0", "1"]);
  });

  it.each([
    ["trailing junk", "7junk"],
    ["fractional seconds", "1.5"],
    ["HTTP-date", "Wed, 21 Oct 2015 07:28:00 GMT"],
    ["oversized seconds", "3601"],
  ])("does not retry a send for %s Retry-After", async (_case, retryAfter) => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () =>
      Response.json(
        { detail: "Rate limit exceeded", code: "rate_limit_exceeded" },
        { status: 429, headers: { "Retry-After": retryAfter } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new BotCordClient({
      hubUrl: "https://hub.example",
      agentId: "ag_test",
      keyId: "k_test",
      privateKey,
      token: "cached-token",
      tokenExpiresAt: Math.floor(Date.now() / 1000) + 3600,
    });

    await expect(client.sendMessage("rm_1", "rate limited")).rejects.toMatchObject({
      status: 429,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("accepts the maximum safe Retry-After boundary", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json(
          { detail: "Rate limit exceeded", code: "rate_limit_exceeded" },
          { status: 429, headers: { "Retry-After": "3600" } },
        ),
      )
      .mockResolvedValueOnce(Response.json({ hub_msg_id: "hub_1" }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new BotCordClient({
      hubUrl: "https://hub.example",
      agentId: "ag_test",
      keyId: "k_test",
      privateKey,
      token: "cached-token",
      tokenExpiresAt: Math.floor(Date.now() / 1000) + 3600,
    });

    const send = client.sendMessage("rm_1", "rate limited");
    await vi.advanceTimersByTimeAsync(3_599_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(send).resolves.toMatchObject({ hub_msg_id: "hub_1" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not downgrade an oversized Retry-After on a read call to fallback retries", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () =>
      Response.json(
        { detail: "Rate limit exceeded", code: "rate_limit_exceeded" },
        { status: 429, headers: { "Retry-After": "3601" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new BotCordClient({
      hubUrl: "https://hub.example",
      agentId: "ag_test",
      keyId: "k_test",
      privateKey,
      token: "cached-token",
      tokenExpiresAt: Math.floor(Date.now() / 1000) + 3600,
    });

    await expect(client.pollInbox({ limit: 50 })).rejects.toMatchObject({
      status: 429,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("treats a leading-zero oversized Retry-After on a read call as oversized", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () =>
      Response.json(
        { detail: "Rate limit exceeded", code: "rate_limit_exceeded" },
        { status: 429, headers: { "Retry-After": "03601" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new BotCordClient({
      hubUrl: "https://hub.example",
      agentId: "ag_test",
      keyId: "k_test",
      privateKey,
      token: "cached-token",
      tokenExpiresAt: Math.floor(Date.now() / 1000) + 3600,
    });

    await expect(client.pollInbox({ limit: 50 })).rejects.toMatchObject({
      status: 429,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ["rate_limit_exceeded", "Rate limit exceeded"],
    ["conversation_rate_limit_exceeded", "Conversation rate limit exceeded"],
    ["slow_mode_wait", "Please wait before sending another message"],
  ])(
    "retries a Hub %s 429 even when its generic 4xx metadata says non-retryable",
    async (code, detail) => {
      vi.useFakeTimers();
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          Response.json({ detail, code, retryable: false }, { status: 429 }),
        )
        .mockResolvedValueOnce(Response.json({ messages: [], count: 0, has_more: false }));
      vi.stubGlobal("fetch", fetchMock);
      const client = new BotCordClient({
        hubUrl: "https://hub.example",
        agentId: "ag_test",
        keyId: "k_test",
        privateKey,
        token: "cached-token",
        tokenExpiresAt: Math.floor(Date.now() / 1000) + 3600,
      });

      const poll = client.pollInbox({ limit: 50 });
      await vi.runAllTimersAsync();
      await poll;

      expect(fetchMock).toHaveBeenCalledTimes(2);
    },
  );

  it("includes structured error_ref on typed error messages", async () => {
    let sentBody: any;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        sentBody = JSON.parse(String(init?.body));
        return Response.json({ hub_msg_id: "hub_1" });
      }),
    );

    const client = new BotCordClient({
      hubUrl: "https://hub.example",
      agentId: "ag_test",
      keyId: "k_test",
      privateKey,
      token: "cached-token",
      tokenExpiresAt: Math.floor(Date.now() / 1000) + 3600,
    });

    await client.sendTypedMessage("rm_1", "error", "Runtime error: codex error", {
      errorRef: "err_abc123",
    });

    expect(sentBody.type).toBe("error");
    expect(sentBody.payload.error).toMatchObject({
      code: "agent_error",
      message: "Runtime error: codex error",
      error_ref: "err_abc123",
    });
  });
});

describe("BotCordClient inbox leases", () => {
  it("serializes ack=false explicitly when polling", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ messages: [], count: 0, has_more: false }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new BotCordClient({
      hubUrl: "https://hub.example",
      agentId: "ag_test",
      keyId: "k_test",
      privateKey,
      token: "cached-token",
      tokenExpiresAt: Math.floor(Date.now() / 1000) + 3600,
    });

    await client.pollInbox({ limit: 50, ack: false });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://hub.example/hub/inbox?limit=50&ack=false",
      expect.any(Object),
    );
  });

  it("renews processing leases for explicit message ids", async () => {
    const fetchMock = vi.fn(async () => Response.json({ renewed: 2 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new BotCordClient({
      hubUrl: "https://hub.example",
      agentId: "ag_test",
      keyId: "k_test",
      privateKey,
      token: "cached-token",
      tokenExpiresAt: Math.floor(Date.now() / 1000) + 3600,
    });

    await client.renewInboxLease(["m_1", "m_2"]);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://hub.example/hub/inbox/lease/renew",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ message_ids: ["m_1", "m_2"] }),
      }),
    );
  });
});
