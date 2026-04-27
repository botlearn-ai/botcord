import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { collectRuntimeSnapshotAsync, type WsEndpointProbeFn } from "../provision.js";

describe("collectRuntimeSnapshotAsync — gateway endpoint probing", () => {
  it("resolves tokenFile and forwards the bearer token to the probe", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "snapshot-tokenfile-"));
    const file = path.join(dir, "tok");
    writeFileSync(file, "rotated-secret\n", { mode: 0o600 });

    const probe = vi.fn<WsEndpointProbeFn>(async () => ({ ok: true, version: "1.2.3" }));
    const out = await collectRuntimeSnapshotAsync({
      cfg: {
        openclawGateways: [
          { name: "remote", url: "ws://example.test:443", tokenFile: file },
        ],
      },
      wsProbe: probe,
    });

    expect(probe).toHaveBeenCalledTimes(1);
    expect(probe.mock.calls[0][0].token).toBe("rotated-secret");
    const acp = out.runtimes.find((r) => r.id === "openclaw-acp");
    expect(acp?.endpoints?.[0]?.reachable).toBe(true);
  });

  it("inline token still wins over tokenFile when both are present", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "snapshot-tokenfile-"));
    const file = path.join(dir, "tok");
    writeFileSync(file, "from-file", { mode: 0o600 });
    const probe = vi.fn<WsEndpointProbeFn>(async () => ({ ok: true }));
    await collectRuntimeSnapshotAsync({
      cfg: {
        openclawGateways: [
          { name: "remote", url: "ws://x", token: "inline", tokenFile: file },
        ],
      },
      wsProbe: probe,
    });
    expect(probe.mock.calls[0][0].token).toBe("inline");
  });

  it("default probe timeout stays well below the Hub's 5s ack budget", async () => {
    let captured = -1;
    const probe: WsEndpointProbeFn = async ({ timeoutMs }) => {
      captured = timeoutMs;
      return { ok: true };
    };
    await collectRuntimeSnapshotAsync({
      cfg: { openclawGateways: [{ name: "p", url: "ws://x" }] },
      wsProbe: probe,
    });
    expect(captured).toBeLessThan(5000);
    expect(captured).toBeGreaterThanOrEqual(1000);
  });

  it("missing tokenFile leaves token undefined and probe still runs", async () => {
    const probe = vi.fn<WsEndpointProbeFn>(async () => ({ ok: false, error: "auth required" }));
    const out = await collectRuntimeSnapshotAsync({
      cfg: {
        openclawGateways: [
          { name: "remote", url: "ws://x", tokenFile: "/does/not/exist" },
        ],
      },
      wsProbe: probe,
    });
    expect(probe).toHaveBeenCalledTimes(1);
    expect(probe.mock.calls[0][0].token).toBeUndefined();
    const acp = out.runtimes.find((r) => r.id === "openclaw-acp");
    expect(acp?.endpoints?.[0]?.reachable).toBe(false);
  });
});
