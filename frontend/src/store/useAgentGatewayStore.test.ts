import { beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayApiError, useAgentGatewayStore } from "@/store/useAgentGatewayStore";

describe("useAgentGatewayStore errors", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useAgentGatewayStore.setState({
      daemonOffline: {},
      lastError: {},
    });
  });

  it("surfaces daemon gateway failure details from Hub", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          detail: {
            code: "daemon_gateway_failed",
            daemon_code: "provider_unreachable",
            daemon_message: "fetch failed",
          },
        }),
        {
          status: 502,
          statusText: "Bad Gateway",
          headers: { "Content-Type": "application/json" },
        },
      ),
    );

    await expect(
      useAgentGatewayStore.getState().pollWechatLogin("ag_1", "wxl_1"),
    ).rejects.toMatchObject({
      message: "fetch failed",
      status: 502,
      code: "provider_unreachable",
    } satisfies Partial<GatewayApiError>);
  });
});
