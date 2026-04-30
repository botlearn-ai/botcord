import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  handleControlFrame,
  patchOpenclawConfigForAgent,
  provisionAgentLocal,
  removeOpenclawConfigForAgent,
  revokeAgentLocal,
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

    // Fresh install → accounts shape with the new agent registered.
    // The multi-account guard only kicks in when *adding* to an
    // already-configured account.
    expect(res.config.applied).toBe(true);
    if (res.config.applied) {
      expect(res.config.reason).toBe("fresh");
    }
    const cfgPath = join(tmpHome, ".openclaw", "openclaw.json");
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
    expect(cfg.channels.botcord.accounts["ag_provtest1234"].credentialsFile).toBe(
      credPath,
    );
    expect(cfg.channels.botcord.enabled).toBe(true);
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

describe("patchOpenclawConfigForAgent", () => {
  it("writes a fresh accounts-shaped config", () => {
    const cfgPath = join(tmpHome, ".openclaw", "openclaw.json");
    const r = patchOpenclawConfigForAgent({
      agentId: "ag_new1",
      credentialsFile: "/tmp/creds.json",
      configPath: cfgPath,
    });
    expect(r).toEqual({ applied: true, reason: "fresh" });
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
    expect(cfg.channels.botcord.enabled).toBe(true);
    expect(cfg.channels.botcord.accounts.ag_new1.credentialsFile).toBe(
      "/tmp/creds.json",
    );
  });

  it("refuses to push an existing single-account config to multi-account", () => {
    const cfgPath = join(tmpHome, ".openclaw", "openclaw.json");
    mkdirSync(join(tmpHome, ".openclaw"), { recursive: true });
    writeFileSync(
      cfgPath,
      JSON.stringify({
        channels: {
          botcord: {
            enabled: true,
            credentialsFile: "/legacy/creds.json",
            deliveryMode: "polling",
          },
        },
      }),
    );
    const r = patchOpenclawConfigForAgent({
      agentId: "ag_new2",
      credentialsFile: "/tmp/new.json",
      configPath: cfgPath,
    });
    expect(r.applied).toBe(false);
    if (r.applied === false) {
      expect(r.reason).toBe("multi_account_guard");
    }
    // Legacy config must remain intact — adding a second account would
    // trigger the SINGLE_ACCOUNT_ONLY guard and break botcord_send.
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
    expect(cfg.channels.botcord.credentialsFile).toBe("/legacy/creds.json");
    expect(cfg.channels.botcord.accounts).toBeUndefined();
  });

  it("rewires legacy single-account when re-attaching the same agent", () => {
    const cfgPath = join(tmpHome, ".openclaw", "openclaw.json");
    mkdirSync(join(tmpHome, ".openclaw"), { recursive: true });
    writeFileSync(
      cfgPath,
      JSON.stringify({
        channels: {
          botcord: {
            enabled: true,
            credentialsFile: "/old/creds.json",
          },
        },
      }),
    );
    const r = patchOpenclawConfigForAgent({
      agentId: "ag_same",
      credentialsFile: "/old/creds.json",
      configPath: cfgPath,
    });
    expect(r).toEqual({ applied: true, reason: "rewired_existing" });
  });

  it("is idempotent when re-patching an unchanged account", () => {
    const cfgPath = join(tmpHome, ".openclaw", "openclaw.json");
    patchOpenclawConfigForAgent({
      agentId: "ag_x",
      credentialsFile: "/c1",
      configPath: cfgPath,
    });
    const r = patchOpenclawConfigForAgent({
      agentId: "ag_x",
      credentialsFile: "/c1",
      configPath: cfgPath,
    });
    expect(r).toEqual({ applied: false, reason: "already_present" });
  });
});

describe("revokeAgentLocal", () => {
  it("removes the OpenClaw account plus credentials and state, preserving workspace", () => {
    const agentId = "ag_cleanup";
    const cfgPath = join(tmpHome, ".openclaw", "openclaw.json");
    const credPath = join(tmpHome, ".botcord", "credentials", `${agentId}.json`);
    const stateDir = join(tmpHome, ".botcord", "agents", agentId, "state");
    const workspaceDir = join(tmpHome, ".botcord", "agents", agentId, "workspace");
    mkdirSync(join(tmpHome, ".openclaw"), { recursive: true });
    mkdirSync(join(tmpHome, ".botcord", "credentials"), { recursive: true });
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(workspaceDir, { recursive: true });
    writeFileSync(credPath, "{}");
    writeFileSync(join(stateDir, "runtime.json"), "{}");
    writeFileSync(join(workspaceDir, "memory.md"), "# keep\n");
    writeFileSync(
      cfgPath,
      JSON.stringify({
        channels: {
          botcord: {
            enabled: true,
            accounts: {
              [agentId]: { enabled: true, credentialsFile: credPath },
            },
          },
        },
      }),
    );

    const result = revokeAgentLocal({ agentId });

    expect(result.config_removed).toBe(true);
    expect(result.credentials_deleted).toBe(true);
    expect(result.state_deleted).toBe(true);
    expect(result.workspace_deleted).toBe(false);
    expect(() => readFileSync(credPath, "utf8")).toThrow();
    expect(() => readFileSync(join(stateDir, "runtime.json"), "utf8")).toThrow();
    expect(readFileSync(join(workspaceDir, "memory.md"), "utf8")).toContain("# keep");
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
    expect(cfg.channels.botcord.accounts).toBeUndefined();
  });

  it("can remove a legacy single-account config entry", () => {
    const agentId = "ag_legacy";
    const cfgPath = join(tmpHome, ".openclaw", "openclaw.json");
    const credPath = join(tmpHome, ".botcord", "credentials", `${agentId}.json`);
    mkdirSync(join(tmpHome, ".openclaw"), { recursive: true });
    writeFileSync(
      cfgPath,
      JSON.stringify({
        channels: { botcord: { enabled: true, credentialsFile: credPath } },
      }),
    );

    const result = removeOpenclawConfigForAgent({
      agentId,
      credentialsFile: credPath,
      configPath: cfgPath,
    });

    expect(result).toEqual({ removed: true, reason: "legacy_credentials" });
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
    expect(cfg.channels.botcord.credentialsFile).toBeUndefined();
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

  it("handles revoke_agent by cleaning local files", async () => {
    const agentId = "ag_frame";
    const credPath = join(tmpHome, ".botcord", "credentials", `${agentId}.json`);
    mkdirSync(join(tmpHome, ".botcord", "credentials"), { recursive: true });
    mkdirSync(join(tmpHome, ".openclaw"), { recursive: true });
    writeFileSync(credPath, "{}");
    writeFileSync(
      join(tmpHome, ".openclaw", "openclaw.json"),
      JSON.stringify({
        channels: {
          botcord: {
            accounts: { [agentId]: { credentialsFile: credPath } },
          },
        },
      }),
    );

    const ack = await handleControlFrame(
      { id: "5", type: "revoke_agent", params: { agentId } },
      baseCtx,
    );

    expect(ack?.ok).toBe(true);
    expect(() => readFileSync(credPath, "utf8")).toThrow();
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
