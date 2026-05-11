import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDaemonStore } from "@/store/useDaemonStore";

describe("useDaemonStore diagnostics", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useDaemonStore.setState({
      collectingDiagnosticsId: null,
      diagnosticErrors: {},
      diagnosticResults: {},
    });
  });

  it("surfaces daemon diagnostics failure details from Hub", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          detail: {
            code: "upstream_error",
            daemon_code: "handler_error",
            daemon_message: "diagnostic upload failed: HTTP 500",
          },
        }),
        {
          status: 502,
          statusText: "Bad Gateway",
          headers: { "Content-Type": "application/json" },
        },
      ),
    );

    const result = await useDaemonStore.getState().collectDiagnostics("dm_1");

    expect(result).toBeNull();
    expect(useDaemonStore.getState().diagnosticErrors.dm_1).toBe(
      "diagnostic upload failed: HTTP 500",
    );
  });
});
