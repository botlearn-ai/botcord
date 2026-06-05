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

  it("normalizes daemon package version from the instance list", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          instances: [
            {
              id: "dm_1",
              label: "workstation",
              kind: "local",
              status: "active",
              online: true,
              created_at: "2026-06-05T00:00:00Z",
              last_seen_at: "2026-06-05T00:01:00Z",
              revoked_at: null,
              removal_requested_at: null,
              cleanup_completed_at: null,
              runtimes: null,
              runtimes_probed_at: null,
              daemon_version: "0.2.96",
            },
            {
              id: "dm_2",
              label: null,
              kind: "local",
              status: "active",
              online: false,
              created_at: "2026-06-05T00:00:00Z",
              last_seen_at: null,
              revoked_at: null,
              removal_requested_at: null,
              cleanup_completed_at: null,
              runtimes: null,
              runtimes_probed_at: null,
              daemon_version: "",
            },
          ],
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );

    await useDaemonStore.getState().refresh();

    expect(useDaemonStore.getState().daemons[0]?.daemon_version).toBe("0.2.96");
    expect(useDaemonStore.getState().daemons[1]?.daemon_version).toBeNull();
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
