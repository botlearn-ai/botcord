/**
 * Setup HTTP server end-to-end tests — WeChat flow + auth + error
 * semantics. Feishu / Telegram setup adapters are Wave 2.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { noopLogger } from "../log.js";
import { IngressOrchestrator } from "../orchestrator.js";
import { ProviderRunner } from "../provider-runner.js";
import { RuntimeSessionManager } from "../runtime/session.js";
import { createWechatSetupAdapter } from "../setup/providers/wechat.js";
import { startSetupServer, type SetupServer } from "../setup/server.js";
import { InMemorySetupSessionStore } from "../setup/sessions.js";
import type { ProviderSetupAdapter } from "../setup/types.js";
import { MemorySecretStore } from "../storage/secrets.js";
import { FileSystemIngressStore } from "../storage/store.js";

const INGRESS_SECRET = "test-ingress-secret-aaaaaaaa";
const FAKE_BOT_TOKEN = "ilink_token_alpha_betagamma_12345";

interface Harness {
  dir: string;
  server: SetupServer;
  url: string;
  sessions: InMemorySetupSessionStore;
  secrets: MemorySecretStore;
  store: FileSystemIngressStore;
  runner: ProviderRunner;
  /** Mutable counter so tests can flip qrcode_status from pending → confirmed. */
  state: { qrConfirmed: boolean; updatesMsgs: unknown[] };
  /** Bag of captured response bodies — used by the secret-leak guard. */
  responses: string[];
  /** Mutable clock so we can advance past TTL. */
  clock: { now: number };
}

async function buildHarness(
  opts: {
    adapters?: Record<string, ProviderSetupAdapter>;
    setupBaseUrl?: string;
    ttlMs?: number;
  } = {},
): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "ingress-setup-srv-"));
  const sessions = new InMemorySetupSessionStore({
    now: () => clock.now,
    ttlMs: opts.ttlMs ?? 5 * 60 * 1000,
  });
  const secrets = new MemorySecretStore();
  const store = new FileSystemIngressStore(dir);
  const clock = { now: 1_700_000_000_000 };

  const state = { qrConfirmed: false, updatesMsgs: [] as unknown[] };
  const fetchImpl = (async (url: string, _init?: RequestInit) => {
    if (url.includes("/ilink/bot/get_bot_qrcode")) {
      return new Response(
        JSON.stringify({ qrcode: "qr-abc", qrcode_url: "https://qr/abc" }),
        { status: 200 },
      );
    }
    if (url.includes("/ilink/bot/get_qrcode_status")) {
      if (state.qrConfirmed) {
        return new Response(
          JSON.stringify({
            status: "confirmed",
            bot_token: FAKE_BOT_TOKEN,
            baseurl: "https://ilinkai.weixin.qq.com",
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ status: "pending" }), { status: 200 });
    }
    if (url.endsWith("/ilink/bot/getupdates")) {
      return new Response(
        JSON.stringify({ ret: 0, get_updates_buf: "buf-1", msgs: state.updatesMsgs }),
        { status: 200 },
      );
    }
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;

  const adapters: Record<string, ProviderSetupAdapter> = {
    wechat: createWechatSetupAdapter({ fetchImpl, baseUrl: "https://ilinkai.weixin.qq.com" }),
    ...(opts.adapters ?? {}),
  };

  // ProviderRunner needs an orchestrator + runtime even if we never start
  // a provider during these tests. Construct them minimally.
  const runtime = new RuntimeSessionManager({
    socketFactory: () =>
      Promise.reject(new Error("runtime ws not used in setup-server tests")),
    log: noopLogger,
    hooks: { onFrame: () => {}, onClose: () => {} },
  });
  const orchestrator = new IngressOrchestrator({
    store,
    hub: {
      ensureRunning: async () => ({ status: "ready", endpoint: "ws://x", token: "t" }),
      runtimeFor: async () => null,
      touch: async () => {},
    } as never,
    log: noopLogger,
    runtime,
    dedupeCapacity: 16,
  });
  const runner = new ProviderRunner({
    store,
    secrets,
    orchestrator,
    log: noopLogger,
    factories: {},
  });

  const server = await startSetupServer({
    host: "127.0.0.1",
    port: 0,
    ingressSecret: INGRESS_SECRET,
    sessions,
    secrets,
    store,
    runner,
    log: noopLogger,
    adapters,
    now: () => clock.now,
  });

  return {
    dir,
    server,
    url: server.url,
    sessions,
    secrets,
    store,
    runner,
    state,
    responses: [],
    clock,
  };
}

async function call(
  url: string,
  path: string,
  init: { method?: string; body?: unknown; secret?: string | null } = {},
  bag?: string[],
): Promise<{ status: number; body: Record<string, unknown>; raw: string }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (init.secret === undefined) {
    headers["authorization"] = `Bearer ${INGRESS_SECRET}`;
  } else if (init.secret !== null) {
    headers["authorization"] = `Bearer ${init.secret}`;
  }
  const res = await fetch(`${url}${path}`, {
    method: init.method ?? "POST",
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const raw = await res.text();
  bag?.push(raw);
  let body: Record<string, unknown> = {};
  if (raw) {
    try {
      body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      body = { _raw: raw };
    }
  }
  return { status: res.status, body, raw };
}

describe("setup-server — WeChat full flow", () => {
  let h: Harness;

  beforeEach(async () => {
    h = await buildHarness();
  });

  afterEach(async () => {
    await h.server.close();
    rmSync(h.dir, { recursive: true, force: true });
  });

  it("walks login/start → status (pending → confirmed) → discover → create → patch → delete", async () => {
    const agentId = "ag_wc_main";
    const baseCtx = { user_id: "usr_1", hosting_kind: "cloud" } as const;

    // start
    const start = await call(
      h.url,
      `/internal/gateway-ingress/agents/${agentId}/gateways/wechat/login/start`,
      { body: { ...baseCtx } },
      h.responses,
    );
    expect(start.status).toBe(200);
    expect(start.body.ok).toBe(true);
    const loginId = start.body.loginId as string;
    expect(loginId).toMatch(/^wxl_/);
    expect((start.body.publicPayload as Record<string, unknown>).qrcode).toBe("qr-abc");

    // status — pending
    const pending = await call(
      h.url,
      `/internal/gateway-ingress/agents/${agentId}/gateways/wechat/login/status`,
      { body: { ...baseCtx, loginId } },
      h.responses,
    );
    expect(pending.status).toBe(200);
    expect(pending.body.status).toBe("pending");

    // status — confirmed (flip the stub)
    h.state.qrConfirmed = true;
    const confirmed = await call(
      h.url,
      `/internal/gateway-ingress/agents/${agentId}/gateways/wechat/login/status`,
      { body: { ...baseCtx, loginId } },
      h.responses,
    );
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.status).toBe("confirmed");
    const tokenPreview = (confirmed.body.publicPayload as Record<string, unknown>).tokenPreview;
    expect(typeof tokenPreview).toBe("string");
    expect(tokenPreview).not.toBe(FAKE_BOT_TOKEN);

    // discover — return one sender
    h.state.updatesMsgs = [
      {
        message_type: 1,
        from_user_id: "alice",
        item_list: [{ type: 1, text_item: { text: "hello" } }],
      },
    ];
    const discover = await call(
      h.url,
      `/internal/gateway-ingress/agents/${agentId}/gateways/wechat/discover`,
      { body: { ...baseCtx, loginId } },
      h.responses,
    );
    expect(discover.status).toBe(200);
    expect((discover.body.candidates as Array<{ senderId: string }>)).toEqual([
      { senderId: "alice", preview: "hello" },
    ]);

    // Hub route split may call this "senders"; keep it as a setup alias.
    const senders = await call(
      h.url,
      `/internal/gateway-ingress/agents/${agentId}/gateways/wechat/senders`,
      { body: { ...baseCtx, loginId } },
      h.responses,
    );
    expect(senders.status).toBe(200);
    expect((senders.body.candidates as Array<{ senderId: string }>)).toEqual([
      { senderId: "alice", preview: "hello" },
    ]);

    // create
    const create = await call(
      h.url,
      `/internal/gateway-ingress/agents/${agentId}/gateways`,
      {
        body: {
          ...baseCtx,
          provider: "wechat",
          loginId,
          label: "Alice's WeChat",
          config: { allowedSenderIds: ["alice"] },
        },
      },
      h.responses,
    );
    expect(create.status).toBe(200);
    const connection = create.body.connection as { id: string; config: Record<string, unknown> };
    expect(connection.id).toMatch(/^gw_wc_/);
    expect(connection.config.allowedSenderIds).toEqual(["alice"]);

    // secret stored under the connection id (§6.1 contract)
    const secret = h.secrets.load<{ botToken?: string }>(connection.id);
    expect(secret?.botToken).toBe(FAKE_BOT_TOKEN);

    // login session is one-shot — should be deleted now
    expect(h.sessions.get(loginId)).toBeNull();

    // patch
    const patch = await call(
      h.url,
      `/internal/gateway-ingress/agents/${agentId}/gateways/${connection.id}`,
      {
        method: "PATCH",
        body: {
          ...baseCtx,
          label: "Renamed",
          enabled: false,
          config: { allowedSenderIds: ["alice", "bob"] },
        },
      },
      h.responses,
    );
    expect(patch.status).toBe(200);
    const patched = patch.body.connection as {
      label: string;
      enabled: boolean;
      config: Record<string, unknown>;
    };
    expect(patched.label).toBe("Renamed");
    expect(patched.enabled).toBe(false);
    expect(patched.config.allowedSenderIds).toEqual(["alice", "bob"]);

    // delete
    const del = await call(
      h.url,
      `/internal/gateway-ingress/agents/${agentId}/gateways/${connection.id}`,
      { method: "DELETE" },
      h.responses,
    );
    expect(del.status).toBe(200);
    expect(h.store.getConnection(connection.id)).toBeNull();
    expect(h.secrets.load(connection.id)).toBeNull();

    // SECRET-LEAK GUARD: bot token must NEVER appear in any response body.
    for (const raw of h.responses) {
      expect(raw).not.toContain(FAKE_BOT_TOKEN);
    }
  });
});

describe("setup-server — auth", () => {
  let h: Harness;

  beforeEach(async () => {
    h = await buildHarness();
  });

  afterEach(async () => {
    await h.server.close();
    rmSync(h.dir, { recursive: true, force: true });
  });

  it("rejects requests without Authorization", async () => {
    const res = await call(
      h.url,
      `/internal/gateway-ingress/agents/ag_x/gateways/wechat/login/start`,
      { body: { user_id: "u", hosting_kind: "cloud" }, secret: null },
    );
    expect(res.status).toBe(401);
    expect((res.body.error as { code: string }).code).toBe("unauthorized");
  });

  it("rejects requests with the wrong secret", async () => {
    const res = await call(
      h.url,
      `/internal/gateway-ingress/agents/ag_x/gateways/wechat/login/start`,
      { body: { user_id: "u", hosting_kind: "cloud" }, secret: "nope-nope-nope-nope-nope-nope-1" },
    );
    expect(res.status).toBe(401);
  });

  it("accepts X-Ingress-Secret as an alternative", async () => {
    const res = await fetch(
      `${h.url}/internal/gateway-ingress/agents/ag_x/gateways/wechat/login/start`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-ingress-secret": INGRESS_SECRET,
        },
        body: JSON.stringify({ user_id: "u", hosting_kind: "cloud" }),
      },
    );
    expect(res.status).toBe(200);
  });
});

describe("setup-server — error semantics", () => {
  let h: Harness;

  beforeEach(async () => {
    h = await buildHarness({ ttlMs: 60_000 });
  });

  afterEach(async () => {
    await h.server.close();
    rmSync(h.dir, { recursive: true, force: true });
  });

  it("returns login_missing for an unknown loginId", async () => {
    const res = await call(
      h.url,
      `/internal/gateway-ingress/agents/ag_x/gateways/wechat/login/status`,
      { body: { user_id: "u", hosting_kind: "cloud", loginId: "wxl_never_existed" } },
    );
    expect(res.status).toBe(404);
    expect((res.body.error as { code: string }).code).toBe("login_missing");
  });

  it("returns login_expired once the fake clock advances past TTL", async () => {
    const start = await call(
      h.url,
      `/internal/gateway-ingress/agents/ag_x/gateways/wechat/login/start`,
      { body: { user_id: "u", hosting_kind: "cloud" } },
    );
    expect(start.status).toBe(200);
    const loginId = start.body.loginId as string;
    // Advance past TTL (60s).
    h.clock.now += 60_001;
    const res = await call(
      h.url,
      `/internal/gateway-ingress/agents/ag_x/gateways/wechat/login/status`,
      { body: { user_id: "u", hosting_kind: "cloud", loginId } },
    );
    expect(res.status).toBe(409);
    expect((res.body.error as { code: string }).code).toBe("login_expired");
  });

  it("returns login_unconfirmed when finalize is called before confirmation", async () => {
    const start = await call(
      h.url,
      `/internal/gateway-ingress/agents/ag_x/gateways/wechat/login/start`,
      { body: { user_id: "u", hosting_kind: "cloud" } },
    );
    const loginId = start.body.loginId as string;
    const res = await call(
      h.url,
      `/internal/gateway-ingress/agents/ag_x/gateways`,
      {
        body: {
          user_id: "u",
          hosting_kind: "cloud",
          provider: "wechat",
          loginId,
          config: {},
        },
      },
    );
    expect(res.status).toBe(409);
    expect((res.body.error as { code: string }).code).toBe("login_unconfirmed");
  });

  it("rejects malformed request bodies with bad_request", async () => {
    const res = await call(
      h.url,
      `/internal/gateway-ingress/agents/ag_x/gateways/wechat/login/start`,
      { body: { hosting_kind: "cloud" } /* missing user_id */ },
    );
    expect(res.status).toBe(400);
    expect((res.body.error as { code: string }).code).toBe("bad_request");
  });
});
