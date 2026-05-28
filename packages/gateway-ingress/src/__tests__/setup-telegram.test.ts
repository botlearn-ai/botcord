/**
 * Telegram setup adapter — full flow + auth/conflict/leak guards.
 *
 * Runs through the setup HTTP server with the Telegram adapter wired
 * in, plus the existing WeChat adapter so we don't accidentally break
 * neighbouring providers. The stub `fetchImpl` simulates Telegram's
 * `getMe` and `getUpdates` endpoints; we never hit the network.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { noopLogger } from "../log.js";
import { IngressOrchestrator } from "../orchestrator.js";
import { ProviderRunner } from "../provider-runner.js";
import { RuntimeSessionManager } from "../runtime/session.js";
import { createTelegramSetupAdapter } from "../setup/providers/telegram.js";
import { createWechatSetupAdapter } from "../setup/providers/wechat.js";
import { startSetupServer, type SetupServer } from "../setup/server.js";
import { InMemorySetupSessionStore } from "../setup/sessions.js";
import { MemorySecretStore } from "../storage/secrets.js";
import { FileSystemIngressStore } from "../storage/store.js";

import { makeRecordingFactory } from "./fixtures.js";

const INGRESS_SECRET = "test-ingress-secret-aaaaaaaa";
const FAKE_TELEGRAM_TOKEN = "fake-telegram-token";

interface FetchState {
  getMeStatus: number; // 200 / 401 / 403 / network
  getMeBody: Record<string, unknown>;
  getUpdates: unknown[];
  /** Bag of all URLs/tokens the stub saw — used by leak guard. */
  seenUrls: string[];
}

interface Harness {
  dir: string;
  server: SetupServer;
  url: string;
  sessions: InMemorySetupSessionStore;
  secrets: MemorySecretStore;
  store: FileSystemIngressStore;
  responses: string[];
  state: FetchState;
  clock: { now: number };
}

async function buildHarness(
  opts: { ttlMs?: number } = {},
): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "ingress-tg-setup-"));
  const clock = { now: 1_700_000_000_000 };
  const sessions = new InMemorySetupSessionStore({
    now: () => clock.now,
    ttlMs: opts.ttlMs ?? 5 * 60 * 1000,
  });
  const secrets = new MemorySecretStore();
  const store = new FileSystemIngressStore(dir);

  const state: FetchState = {
    getMeStatus: 200,
    getMeBody: {
      ok: true,
      result: { id: 99, is_bot: true, username: "fake_bot", first_name: "Fakey" },
    },
    getUpdates: [],
    seenUrls: [],
  };

  const fetchImpl = (async (url: string, _init?: RequestInit) => {
    state.seenUrls.push(url);
    if (url.includes("/getMe")) {
      if (state.getMeStatus !== 200) {
        return new Response(
          JSON.stringify({ ok: false, error_code: state.getMeStatus, description: "Unauthorized" }),
          { status: state.getMeStatus },
        );
      }
      return new Response(JSON.stringify(state.getMeBody), { status: 200 });
    }
    if (url.includes("/getUpdates")) {
      return new Response(
        JSON.stringify({ ok: true, result: state.getUpdates }),
        { status: 200 },
      );
    }
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;

  const runtime = new RuntimeSessionManager({
    socketFactory: () =>
      Promise.reject(new Error("runtime ws not used in telegram setup tests")),
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
    // Phase 3: finalize now kicks the runner. Provide a noop factory so
    // the setup tests don't accidentally start the real telegram poller.
    factories: { telegram: makeRecordingFactory("telegram").factory },
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
    adapters: {
      // Keep the wechat adapter present so we can verify neighbour
      // providers aren't broken by wiring telegram in.
      wechat: createWechatSetupAdapter(),
      telegram: createTelegramSetupAdapter({
        fetchImpl,
        baseUrl: "https://api.telegram.org",
      }),
    },
    now: () => clock.now,
  });

  return {
    dir,
    server,
    url: server.url,
    sessions,
    secrets,
    store,
    responses: [],
    state,
    clock,
  };
}

async function call(
  url: string,
  path: string,
  init: { method?: string; body?: unknown } = {},
  bag?: string[],
): Promise<{ status: number; body: Record<string, unknown>; raw: string }> {
  const res = await fetch(`${url}${path}`, {
    method: init.method ?? "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${INGRESS_SECRET}`,
    },
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

describe("telegram setup — full flow", () => {
  let h: Harness;

  beforeEach(async () => {
    h = await buildHarness();
  });

  afterEach(async () => {
    await h.server.close();
    rmSync(h.dir, { recursive: true, force: true });
  });

  it("walks loginStart → loginStatus → discover → finalize", async () => {
    const agentId = "ag_tg_main";
    const baseCtx = { user_id: "usr_1", hosting_kind: "cloud" } as const;

    // loginStart with botToken at top-level
    const start = await call(
      h.url,
      `/internal/gateway-ingress/agents/${agentId}/gateways/telegram/login/start`,
      { body: { ...baseCtx, botToken: FAKE_TELEGRAM_TOKEN } },
      h.responses,
    );
    expect(start.status).toBe(200);
    expect(start.body.ok).toBe(true);
    const loginId = start.body.loginId as string;
    expect(loginId).toMatch(/^tgl_/);
    const startPub = start.body.publicPayload as Record<string, unknown>;
    expect(startPub.botInfo).toMatchObject({ id: 99, username: "fake_bot" });
    // tokenPreview must NEVER be the raw token
    expect(startPub.tokenPreview).not.toBe(FAKE_TELEGRAM_TOKEN);

    // loginStatus — confirmed (synchronous for telegram)
    const status = await call(
      h.url,
      `/internal/gateway-ingress/agents/${agentId}/gateways/telegram/login/status`,
      { body: { ...baseCtx, loginId } },
      h.responses,
    );
    expect(status.status).toBe(200);
    expect(status.body.status).toBe("confirmed");

    // discover — return 2 chats / 3 senders
    h.state.getUpdates = [
      {
        update_id: 1,
        message: {
          message_id: 10,
          from: { id: 100, username: "alice", first_name: "Alice" },
          chat: { id: -500, type: "group", title: "Team" },
        },
      },
      {
        update_id: 2,
        message: {
          message_id: 11,
          from: { id: 101, username: "bob", first_name: "Bob" },
          chat: { id: -500, type: "group", title: "Team" },
        },
      },
      {
        update_id: 3,
        message: {
          message_id: 12,
          from: { id: 102, first_name: "Carol" },
          chat: { id: 102, type: "private", first_name: "Carol" },
        },
      },
    ];
    const discover = await call(
      h.url,
      `/internal/gateway-ingress/agents/${agentId}/gateways/telegram/discover`,
      { body: { ...baseCtx, loginId } },
      h.responses,
    );
    expect(discover.status).toBe(200);
    const chats = discover.body.chats as Array<Record<string, unknown>>;
    const senders = discover.body.senders as Array<Record<string, unknown>>;
    expect(chats.map((c) => c.id).sort()).toEqual(["-500", "102"]);
    expect(senders.map((s) => s.id).sort()).toEqual(["100", "101", "102"]);

    // finalize
    const create = await call(
      h.url,
      `/internal/gateway-ingress/agents/${agentId}/gateways`,
      {
        body: {
          ...baseCtx,
          provider: "telegram",
          loginId,
          label: "My Bot",
          config: {
            allowedChatIds: ["-500"],
            allowedSenderIds: ["100", "101"],
          },
        },
      },
      h.responses,
    );
    expect(create.status).toBe(200);
    const connection = create.body.connection as {
      id: string;
      provider: string;
      status: string;
      enabled: boolean;
      config: Record<string, unknown>;
    };
    expect(connection.provider).toBe("telegram");
    expect(connection.id).toMatch(/^gw_tg_/);
    expect(connection.status).toBe("active");
    expect(connection.enabled).toBe(true);
    expect(connection.config.allowedChatIds).toEqual(["-500"]);
    expect(connection.config.allowedSenderIds).toEqual(["100", "101"]);
    expect(typeof connection.config.tokenFingerprint).toBe("string");
    // fingerprint must NOT be the raw token
    expect(connection.config.tokenFingerprint).not.toBe(FAKE_TELEGRAM_TOKEN);

    // secret stored under the connection id
    const secret = h.secrets.load<{ botToken?: string; baseUrl?: string }>(connection.id);
    expect(secret?.botToken).toBe(FAKE_TELEGRAM_TOKEN);
    expect(secret?.baseUrl).toBe("https://api.telegram.org");

    // setup session deleted (one-shot)
    expect(h.sessions.get(loginId)).toBeNull();

    // SECRET-LEAK GUARD: bot token never in any response body.
    for (const raw of h.responses) {
      expect(raw).not.toContain(FAKE_TELEGRAM_TOKEN);
    }
  });
});

describe("telegram setup — error semantics", () => {
  let h: Harness;

  beforeEach(async () => {
    h = await buildHarness({ ttlMs: 60_000 });
  });

  afterEach(async () => {
    await h.server.close();
    rmSync(h.dir, { recursive: true, force: true });
  });

  it("returns provider_auth_failed when getMe returns 401", async () => {
    h.state.getMeStatus = 401;
    const res = await call(
      h.url,
      `/internal/gateway-ingress/agents/ag_x/gateways/telegram/login/start`,
      {
        body: {
          user_id: "u",
          hosting_kind: "cloud",
          botToken: FAKE_TELEGRAM_TOKEN,
        },
      },
      h.responses,
    );
    expect(res.status).toBe(401);
    expect((res.body.error as { code: string }).code).toBe("provider_auth_failed");
    // SECRET-LEAK GUARD even on the error path.
    for (const raw of h.responses) {
      expect(raw).not.toContain(FAKE_TELEGRAM_TOKEN);
    }
  });

  it("returns bad_request when botToken is missing", async () => {
    const res = await call(
      h.url,
      `/internal/gateway-ingress/agents/ag_x/gateways/telegram/login/start`,
      { body: { user_id: "u", hosting_kind: "cloud" } },
    );
    expect(res.status).toBe(400);
    expect((res.body.error as { code: string }).code).toBe("bad_request");
  });

  it("returns gateway_conflict when the same bot token is finalized twice", async () => {
    const agentA = "ag_tg_a";
    const agentB = "ag_tg_b";
    const baseCtx = { user_id: "u", hosting_kind: "cloud" } as const;

    // First gateway finalizes successfully.
    const start1 = await call(
      h.url,
      `/internal/gateway-ingress/agents/${agentA}/gateways/telegram/login/start`,
      { body: { ...baseCtx, botToken: FAKE_TELEGRAM_TOKEN } },
      h.responses,
    );
    const loginId1 = start1.body.loginId as string;
    const create1 = await call(
      h.url,
      `/internal/gateway-ingress/agents/${agentA}/gateways`,
      {
        body: {
          ...baseCtx,
          provider: "telegram",
          loginId: loginId1,
          config: { allowedChatIds: [], allowedSenderIds: [] },
        },
      },
      h.responses,
    );
    expect(create1.status).toBe(200);

    // Second login/start with same token, then finalize → conflict.
    const start2 = await call(
      h.url,
      `/internal/gateway-ingress/agents/${agentB}/gateways/telegram/login/start`,
      { body: { ...baseCtx, botToken: FAKE_TELEGRAM_TOKEN } },
      h.responses,
    );
    const loginId2 = start2.body.loginId as string;
    const create2 = await call(
      h.url,
      `/internal/gateway-ingress/agents/${agentB}/gateways`,
      {
        body: {
          ...baseCtx,
          provider: "telegram",
          loginId: loginId2,
          config: { allowedChatIds: [], allowedSenderIds: [] },
        },
      },
      h.responses,
    );
    expect(create2.status).toBe(409);
    expect((create2.body.error as { code: string }).code).toBe("gateway_conflict");

    // SECRET-LEAK GUARD covering the entire flow.
    for (const raw of h.responses) {
      expect(raw).not.toContain(FAKE_TELEGRAM_TOKEN);
    }
  });
});
