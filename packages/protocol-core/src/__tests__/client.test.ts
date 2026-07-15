import { afterEach, describe, expect, it, vi } from "vitest";
import { BotCordClient } from "../client.js";

const privateKey = Buffer.alloc(32, 2).toString("base64");

afterEach(() => {
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
    const requests: Array<{ url: string; authorization?: string }> = [];
    let inboxAttempts = 0;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const headers = (init?.headers ?? {}) as Record<string, string>;
        requests.push({ url, authorization: headers.Authorization });

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
    expect(inboxRequests[0].authorization).toBe("Bearer old-token");
    expect(inboxRequests[1].authorization).toBe("Bearer new-token");
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
