import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  handleControlFrame,
  provisionAgentLocal,
} from "../host-control.js";

const fakeHost = {
  version: 1 as const,
  hubUrl: "http://hub.test",
  hostInstanceId: "oc_aaaaaaaaaaaa",
  privateKey: "Z".repeat(43) + "=", // unused in these tests
  publicKey: "Z".repeat(43) + "=",
  accessToken: "host-access-token",
  refreshToken: "host-refresh-token",
  accessExpiresAt: Math.floor(Date.now() / 1000) + 3600,
  refreshExpiresAt: Math.floor(Date.now() / 1000) + 86_400,
  controlWsUrl: "ws://hub.test/openclaw/control",
};

let tmpHome: string;
let originalHome: string | undefined;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "botcord-host-"));
  originalHome = process.env.HOME;
  process.env.HOME = tmpHome;
});

afterEach(() => {
  if (originalHome !== undefined) process.env.HOME = originalHome;
  else delete process.env.HOME;
  rmSync(tmpHome, { recursive: true, force: true });
});

describe("provisionAgentLocal", () => {
  it("posts host bearer + signed nonce, writes credentials, returns agent_id", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("http://hub.test/openclaw/host/provision-claim");
      const body = JSON.parse((init!.body as string) ?? "{}");
      expect(body.provision_id).toBe("prv_test");
      expect(body.nonce).toBe(Buffer.from("nonce-bytes-32-chars-long-padding").toString("base64"));
      expect(body.agent.pubkey.startsWith("ed25519:")).toBe(true);
      expect(body.agent.proof.nonce).toBe(body.nonce);
      expect(typeof body.agent.proof.sig).toBe("string");
      const headers = init!.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer host-access-token");

      return new Response(
        JSON.stringify({
          agent_id: "ag_provtest1234",
          key_id: "k_provtest123",
          token: "agent-token-xyz",
          token_expires_at: Math.floor(Date.now() / 1000) + 3600,
          display_name: "Provisioned Agent",
          bio: null,
        }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      );
    });

    const res = await provisionAgentLocal({
      host: fakeHost,
      provisionId: "prv_test",
      nonce: Buffer.from("nonce-bytes-32-chars-long-padding").toString("base64"),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(res.result.agent_id).toBe("ag_provtest1234");
    const credPath = join(tmpHome, ".botcord", "credentials", "ag_provtest1234.json");
    const written = JSON.parse(readFileSync(credPath, "utf8"));
    expect(written.agentId).toBe("ag_provtest1234");
    expect(written.token).toBe("agent-token-xyz");
    expect(written.openclawHostId).toBe("oc_aaaaaaaaaaaa");
    expect(written.privateKey).toBe(res.privateKey);
  });

  it("throws on non-2xx response", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("INVALID_PROVISION", { status: 400 }),
    );
    await expect(
      provisionAgentLocal({
        host: fakeHost,
        provisionId: "prv_x",
        nonce: "AAAA",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/provision-claim failed: 400/);
  });
});

describe("handleControlFrame", () => {
  const baseCtx = {
    host: fakeHost,
    log: () => {},
  };

  it("acks hello + ping", async () => {
    expect(await handleControlFrame({ id: "1", type: "hello" }, baseCtx)).toEqual({
      ok: true,
    });
    const pong = await handleControlFrame({ id: "2", type: "ping" }, baseCtx);
    expect(pong).toEqual({ ok: true, result: { pong: true } });
  });

  it("rejects provision_agent missing params", async () => {
    const ack = await handleControlFrame(
      { id: "3", type: "provision_agent", params: {} },
      baseCtx,
    );
    expect(ack).toEqual({
      ok: false,
      error: { code: "bad_params", message: "provision_id and nonce required" },
    });
  });

  it("returns unknown_type for unrecognised frames", async () => {
    const ack = await handleControlFrame(
      { id: "4", type: "frobnicate" },
      baseCtx,
    );
    expect(ack).toEqual({
      ok: false,
      error: {
        code: "unknown_type",
        message: "unknown frame type: frobnicate",
      },
    });
  });
});
