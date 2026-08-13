import { afterEach, describe, expect, it, vi } from "vitest";
import { BotCordClient } from "../client.js";

const privateKey = Buffer.alloc(32, 2).toString("base64");

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
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
