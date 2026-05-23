import { describe, expect, it } from "vitest";

import { createHubClient, HubClientError } from "../hub-client.js";

describe("HubClient", () => {
  it("attaches bearer + serializes body for ensureRunning", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(
        JSON.stringify({
          agent_id: "ag_x",
          status: "ready",
          runtime: {
            session_endpoint: "ws://h/runtime",
            session_token: "tok",
            expires_in: 300,
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const hub = createHubClient({
      baseUrl: "http://hub.test/",
      ingressSecret: "secret-1",
      fetchImpl,
    });

    const res = await hub.ensureRunning("ag_x", {
      gateway_id: "gw_1",
      reason: "third_party_inbound",
      event_id: "evt_abc",
    });
    expect(res.status).toBe("ready");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(
      "http://hub.test/internal/cloud-gateway/agents/ag_x/ensure-running",
    );
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer secret-1");
    expect(headers["Content-Type"]).toBe("application/json");
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body).toEqual({
      gateway_id: "gw_1",
      reason: "third_party_inbound",
      event_id: "evt_abc",
    });
  });

  it("applies runtimeEndpointOverride to the returned metadata", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          agent_id: "ag_x",
          status: "ready",
          runtime: {
            session_endpoint: "ws://hub-default",
            session_token: "tok",
            expires_in: 300,
          },
        }),
        { status: 200 },
      )) as unknown as typeof fetch;
    const hub = createHubClient({
      baseUrl: "http://h",
      ingressSecret: "x",
      fetchImpl,
      runtimeEndpointOverride: "ws://relay/runtime",
    });
    const res = await hub.ensureRunning("ag_x", {
      gateway_id: "gw_1",
      reason: "third_party_inbound",
    });
    expect(res.runtime?.session_endpoint).toBe("ws://relay/runtime");
  });

  it("translates non-ok responses into HubClientError", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ detail: "boom", code: "internal_endpoints_disabled" }), {
        status: 403,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    const hub = createHubClient({
      baseUrl: "http://h",
      ingressSecret: "x",
      fetchImpl,
    });
    await expect(
      hub.ensureRunning("ag_x", { gateway_id: "gw", reason: "third_party_inbound" }),
    ).rejects.toBeInstanceOf(HubClientError);
  });

  it("touch posts the right shape", async () => {
    const fetchImpl = (async (url: string, init: RequestInit) => {
      return new Response(
        JSON.stringify({ agent_id: "ag_x", acknowledged_at: 1700000000000 }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const hub = createHubClient({ baseUrl: "http://h", ingressSecret: "x", fetchImpl });
    const res = await hub.touch("ag_x", { gateway_id: "gw_1", reason: "outbound_sent" });
    expect(res.acknowledged_at).toBe(1700000000000);
  });
});
