import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDaemonStore } from "@/store/useDaemonStore";

describe("useDaemonStore", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useDaemonStore.setState({
      daemons: [],
      refreshingRuntimesId: null,
      runtimeErrors: {},
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

  it("marks a daemon offline when runtime refresh reports daemon_offline", async () => {
    useDaemonStore.setState({
      daemons: [
        {
          id: "dm_1",
          label: "workstation",
          status: "online",
          created_at: null,
          last_seen_at: null,
          revoked_at: null,
          removal_requested_at: null,
          cleanup_completed_at: null,
          runtimes: [
            {
              id: "codex",
              available: true,
            },
          ],
          runtimes_probed_at: null,
        },
      ],
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          detail: "daemon_offline",
          error: "daemon_offline",
          hint: null,
          retryable: false,
        }),
        {
          status: 409,
          statusText: "Conflict",
          headers: { "Content-Type": "application/json" },
        },
      ),
    );

    await useDaemonStore.getState().refreshRuntimes("dm_1");

    expect(useDaemonStore.getState().daemons[0]?.status).toBe("offline");
    expect(useDaemonStore.getState().refreshingRuntimesId).toBeNull();
    expect(useDaemonStore.getState().runtimeErrors.dm_1).toBe(
      "daemon offline, start it first",
    );
  });
});
