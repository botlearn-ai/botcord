/**
 * Feishu setup HTTP server tests — full PersonalAgent registration
 * flow + error semantics + secret-leak guard.
 *
 * Wave 2 sibling of `setup-server.test.ts` (which covers WeChat). The
 * harness mirrors that file's shape so the two stay easy to diff.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { noopLogger } from "../log.js";
import { IngressOrchestrator } from "../orchestrator.js";
import { ProviderRunner } from "../provider-runner.js";
import { RuntimeSessionManager } from "../runtime/session.js";
import { createFeishuSetupAdapter } from "../setup/providers/feishu.js";
import { startSetupServer, type SetupServer } from "../setup/server.js";
import { InMemorySetupSessionStore } from "../setup/sessions.js";
import type { ProviderSetupAdapter } from "../setup/types.js";
import { MemorySecretStore } from "../storage/secrets.js";
import { FileSystemIngressStore } from "../storage/store.js";

import { makeRecordingFactory } from "./fixtures.js";

const INGRESS_SECRET = "test-ingress-secret-fs-aaaaaaaa";
const FAKE_APP_ID = "cli_fake_app_alpha_beta_12345";
const FAKE_APP_SECRET = "fake-app-secret-must-never-leak-7777";
const FAKE_OPEN_ID = "ou_fake_open_id_alice_aaaa";
const DEVICE_CODE = "dc_alpha_beta_gamma_12345";
const VERIFICATION_URL = "https://accounts.feishu.cn/personal_agent?code=dc_alpha";

type RegistrationPhase = "pending" | "confirmed" | "denied" | "expired" | "fail";
type FeishuSdkOverride = NonNullable<
  Parameters<typeof createFeishuSetupAdapter>[0]
>["sdkOverride"];

interface Harness {
  dir: string;
  server: SetupServer;
  url: string;
  sessions: InMemorySetupSessionStore;
  secrets: MemorySecretStore;
  store: FileSystemIngressStore;
  state: { phase: RegistrationPhase; tokenProbeOk: boolean };
  responses: string[];
  clock: { now: number };
}

async function buildHarness(
  opts: {
    adapters?: Record<string, ProviderSetupAdapter>;
    ttlMs?: number;
    feishuSdkOverride?: FeishuSdkOverride;
  } = {},
): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "ingress-setup-feishu-"));
  const clock = { now: 1_700_000_000_000 };
  const sessions = new InMemorySetupSessionStore({
    now: () => clock.now,
    ttlMs: opts.ttlMs ?? 5 * 60 * 1000,
  });
  const secrets = new MemorySecretStore();
  const store = new FileSystemIngressStore(dir);

  const state = { phase: "pending" as RegistrationPhase, tokenProbeOk: true };

  // Minimal stub that mimics the Feishu/Lark registration + open-API
  // endpoints. Each branch returns a Response-shaped object compatible
  // with our FetchLike contract.
  const fetchImpl = (async (url: string, init?: { body?: unknown }) => {
    const body = typeof init?.body === "string" ? init.body : "";
    if (url.endsWith("/oauth/v1/app/registration")) {
      const action = (body.match(/(^|&)action=([^&]+)/)?.[2] ?? "").trim();
      if (action === "init") {
        return json({ supported_auth_methods: ["client_secret"] });
      }
      if (action === "begin") {
        return json({
          device_code: DEVICE_CODE,
          verification_uri_complete: VERIFICATION_URL,
          verification_uri: "https://accounts.feishu.cn/personal_agent",
          expire_in: 600,
          interval: 5,
        });
      }
      if (action === "poll") {
        switch (state.phase) {
          case "confirmed":
            return json({
              client_id: FAKE_APP_ID,
              client_secret: FAKE_APP_SECRET,
              user_info: { open_id: FAKE_OPEN_ID, tenant_brand: "feishu" },
            });
          case "denied":
            return json({ error: "access_denied" });
          case "expired":
            return json({ error: "expired_token" });
          case "fail":
            return json({ error: "unsupported_grant_type" });
          default:
            return json({ error: "authorization_pending" });
        }
      }
    }
    if (url.endsWith("/open-apis/auth/v3/tenant_access_token/internal")) {
      return json(
        state.tokenProbeOk
          ? { code: 0, msg: "ok", tenant_access_token: "tat_xxx", expire: 7200 }
          : { code: 99991663, msg: "invalid app secret" },
      );
    }
    return json({});
  }) as never;

  const adapters: Record<string, ProviderSetupAdapter> = {
    feishu: createFeishuSetupAdapter({
      fetchImpl,
      ...(opts.feishuSdkOverride ? { sdkOverride: opts.feishuSdkOverride } : {}),
    }),
    ...(opts.adapters ?? {}),
  };

  const runtime = new RuntimeSessionManager({
    socketFactory: () =>
      Promise.reject(new Error("runtime ws not used in setup-feishu tests")),
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
    // the setup tests don't accidentally exercise the real feishu
    // event-WS adapter — those paths are covered by feishu.test.ts.
    factories: { feishu: makeRecordingFactory("feishu").factory },
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
    state,
    responses: [],
    clock,
  };
}

function json(body: unknown): {
  status: number;
  ok: boolean;
  text(): Promise<string>;
} {
  return {
    status: 200,
    ok: true,
    text: async () => JSON.stringify(body),
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

describe("setup-server — Feishu full flow", () => {
  let h: Harness;

  beforeEach(async () => {
    h = await buildHarness();
  });

  afterEach(async () => {
    await h.server.close();
    rmSync(h.dir, { recursive: true, force: true });
  });

  it("walks login/start → status (pending → confirmed) → finalize → test, with no secret leakage", async () => {
    const agentId = "ag_fs_main";
    const baseCtx = { user_id: "usr_1", hosting_kind: "cloud" } as const;

    // start
    const start = await call(
      h.url,
      `/internal/gateway-ingress/agents/${agentId}/gateways/feishu/login/start`,
      { body: { ...baseCtx } },
      h.responses,
    );
    expect(start.status).toBe(200);
    expect(start.body.ok).toBe(true);
    const loginId = start.body.loginId as string;
    expect(loginId).toMatch(/^fsl_/);
    const startPub = start.body.publicPayload as Record<string, unknown>;
    expect(startPub.qrcode).toBe(DEVICE_CODE);
    expect(startPub.qrcodeUrl).toBe(VERIFICATION_URL);
    expect(startPub.domain).toBe("feishu");

    // status — pending
    const pending = await call(
      h.url,
      `/internal/gateway-ingress/agents/${agentId}/gateways/feishu/login/status`,
      { body: { ...baseCtx, loginId } },
      h.responses,
    );
    expect(pending.status).toBe(200);
    expect(pending.body.status).toBe("pending");

    // status — confirmed
    h.state.phase = "confirmed";
    const confirmed = await call(
      h.url,
      `/internal/gateway-ingress/agents/${agentId}/gateways/feishu/login/status`,
      { body: { ...baseCtx, loginId } },
      h.responses,
    );
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.status).toBe("confirmed");
    const confirmedPub = confirmed.body.publicPayload as Record<string, unknown>;
    expect(confirmedPub.appId).toBe(FAKE_APP_ID);
    expect(confirmedPub.userOpenId).toBe(FAKE_OPEN_ID);
    expect(confirmedPub.domain).toBe("feishu");
    expect(typeof confirmedPub.tokenPreview).toBe("string");
    expect(confirmedPub.tokenPreview).not.toBe(FAKE_APP_SECRET);
    // appSecret never returned
    expect(confirmedPub.appSecret).toBeUndefined();

    // re-poll while confirmed: should be a cached read (we flip the
    // stub to "fail" — if the adapter re-polled, the status would now
    // flip to "failed").
    h.state.phase = "fail";
    const cached = await call(
      h.url,
      `/internal/gateway-ingress/agents/${agentId}/gateways/feishu/login/status`,
      { body: { ...baseCtx, loginId } },
      h.responses,
    );
    expect(cached.body.status).toBe("confirmed");
    h.state.phase = "confirmed";

    // finalize
    const create = await call(
      h.url,
      `/internal/gateway-ingress/agents/${agentId}/gateways`,
      {
        body: {
          ...baseCtx,
          provider: "feishu",
          loginId,
          label: "Alice's Feishu",
          config: { allowedChatIds: ["oc_chat_1"] },
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
      secretRef?: unknown;
    };
    expect(connection.id).toMatch(/^gw_fs_/);
    expect(connection.provider).toBe("feishu");
    expect(connection.status).toBe("active");
    expect(connection.enabled).toBe(true);
    expect(connection.config.domain).toBe("feishu");
    expect(connection.config.userOpenId).toBe(FAKE_OPEN_ID);
    // userOpenId defaulted into allowedSenderIds at finalize time
    expect(connection.config.allowedSenderIds).toEqual([FAKE_OPEN_ID]);
    expect(connection.config.allowedChatIds).toEqual(["oc_chat_1"]);
    // secretRef is dropped from the outbound shape
    expect(connection.secretRef).toBeUndefined();

    // secret is written under the connection id (§6.1)
    const stored = h.secrets.load<{
      appId?: string;
      appSecret?: string;
      domain?: string;
      userOpenId?: string;
    }>(connection.id);
    expect(stored?.appId).toBe(FAKE_APP_ID);
    expect(stored?.appSecret).toBe(FAKE_APP_SECRET);
    expect(stored?.domain).toBe("feishu");
    expect(stored?.userOpenId).toBe(FAKE_OPEN_ID);

    // login session is one-shot — deleted after finalize
    expect(h.sessions.get(loginId)).toBeNull();

    // test endpoint — happy path
    const testOk = await call(
      h.url,
      `/internal/gateway-ingress/agents/${agentId}/gateways/${connection.id}/test`,
      { body: { ...baseCtx } },
      h.responses,
    );
    expect(testOk.status).toBe(200);
    expect(testOk.body.ok).toBe(true);

    // test endpoint — credential probe fails
    h.state.tokenProbeOk = false;
    const testBad = await call(
      h.url,
      `/internal/gateway-ingress/agents/${agentId}/gateways/${connection.id}/test`,
      { body: { ...baseCtx } },
      h.responses,
    );
    expect(testBad.status).toBe(200);
    expect(testBad.body.ok).toBe(false);

    // SECRET-LEAK GUARD: appSecret must NEVER appear in any response.
    for (const raw of h.responses) {
      expect(raw).not.toContain(FAKE_APP_SECRET);
    }
  });

  it("honors lark domain override on login/start", async () => {
    const start = await call(
      h.url,
      `/internal/gateway-ingress/agents/ag_fs_lark/gateways/feishu/login/start`,
      { body: { user_id: "u", hosting_kind: "cloud", options: { domain: "lark" } } },
      h.responses,
    );
    expect(start.status).toBe(200);
    const pub = start.body.publicPayload as Record<string, unknown>;
    expect(pub.domain).toBe("lark");
  });

  it("defaults allowedSenderIds to [userOpenId] when caller omits it", async () => {
    const agentId = "ag_fs_default_sender";
    const baseCtx = { user_id: "u", hosting_kind: "cloud" } as const;
    const start = await call(
      h.url,
      `/internal/gateway-ingress/agents/${agentId}/gateways/feishu/login/start`,
      { body: { ...baseCtx } },
      h.responses,
    );
    const loginId = start.body.loginId as string;
    h.state.phase = "confirmed";
    await call(
      h.url,
      `/internal/gateway-ingress/agents/${agentId}/gateways/feishu/login/status`,
      { body: { ...baseCtx, loginId } },
      h.responses,
    );
    const create = await call(
      h.url,
      `/internal/gateway-ingress/agents/${agentId}/gateways`,
      {
        body: { ...baseCtx, provider: "feishu", loginId, config: {} },
      },
      h.responses,
    );
    expect(create.status).toBe(200);
    const connection = create.body.connection as { config: Record<string, unknown> };
    expect(connection.config.allowedSenderIds).toEqual([FAKE_OPEN_ID]);
  });

  it("discovers Feishu chat_id from the registered user before finalize", async () => {
    await h.server.close();
    rmSync(h.dir, { recursive: true, force: true });
    let handlers: Record<string, (data: unknown) => unknown> = {};
    const starts: Record<string, unknown>[] = [];
    h = await buildHarness({
      feishuSdkOverride: {
        createDispatcher: () => ({
          register: (next) => {
            handlers = next;
          },
        }),
        createWsClient: (args) => ({
          start: () => {
            starts.push(args);
            handlers["im.message.receive_v1"]?.({
              sender: { sender_id: { open_id: "ou_intruder" } },
              message: { chat_id: "oc_wrong", chat_type: "group", create_time: "1" },
            });
            handlers["im.message.receive_v1"]?.({
              sender: { sender_id: { open_id: FAKE_OPEN_ID } },
              message: {
                chat_id: "oc_team",
                chat_type: "group",
                create_time: "1700000000123",
                mentions: [{ id: { open_id: FAKE_OPEN_ID }, name: "Alice" }],
              },
            });
          },
          close: () => {},
        }),
      },
    });

    const agentId = "ag_fs_discover";
    const baseCtx = { user_id: "u", hosting_kind: "cloud" } as const;
    const start = await call(
      h.url,
      `/internal/gateway-ingress/agents/${agentId}/gateways/feishu/login/start`,
      { body: { ...baseCtx } },
      h.responses,
    );
    const loginId = start.body.loginId as string;
    h.state.phase = "confirmed";
    await call(
      h.url,
      `/internal/gateway-ingress/agents/${agentId}/gateways/feishu/login/status`,
      { body: { ...baseCtx, loginId } },
      h.responses,
    );

    const discover = await call(
      h.url,
      `/internal/gateway-ingress/agents/${agentId}/gateways/feishu/discover`,
      { body: { ...baseCtx, loginId, timeoutSeconds: 1 } },
      h.responses,
    );

    expect(discover.status).toBe(200);
    expect(starts).toHaveLength(1);
    expect(starts[0]?.appId).toBe(FAKE_APP_ID);
    expect(starts[0]?.appSecret).toBe(FAKE_APP_SECRET);
    expect(discover.body.chats).toEqual([
      {
        chatId: "oc_team",
        senderOpenId: FAKE_OPEN_ID,
        kind: "group",
        label: "Alice",
        lastSeenAt: 1700000000123,
      },
    ]);
    expect(discover.body.candidates).toEqual(discover.body.chats);
    expect(JSON.stringify(discover.body)).not.toContain(FAKE_APP_SECRET);
  });
});

describe("setup-server — Feishu error semantics", () => {
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
      `/internal/gateway-ingress/agents/ag_x/gateways/feishu/login/status`,
      { body: { user_id: "u", hosting_kind: "cloud", loginId: "fsl_never_existed" } },
      h.responses,
    );
    expect(res.status).toBe(404);
    expect((res.body.error as { code: string }).code).toBe("login_missing");
  });

  it("returns login_expired once the fake clock passes TTL", async () => {
    const start = await call(
      h.url,
      `/internal/gateway-ingress/agents/ag_x/gateways/feishu/login/start`,
      { body: { user_id: "u", hosting_kind: "cloud" } },
      h.responses,
    );
    const loginId = start.body.loginId as string;
    h.clock.now += 60_001;
    const res = await call(
      h.url,
      `/internal/gateway-ingress/agents/ag_x/gateways/feishu/login/status`,
      { body: { user_id: "u", hosting_kind: "cloud", loginId } },
      h.responses,
    );
    expect(res.status).toBe(409);
    expect((res.body.error as { code: string }).code).toBe("login_expired");
  });

  it("returns login_unconfirmed when finalize is called before confirmation", async () => {
    const agentId = "ag_x";
    const baseCtx = { user_id: "u", hosting_kind: "cloud" } as const;
    const start = await call(
      h.url,
      `/internal/gateway-ingress/agents/${agentId}/gateways/feishu/login/start`,
      { body: { ...baseCtx } },
      h.responses,
    );
    const loginId = start.body.loginId as string;
    const res = await call(
      h.url,
      `/internal/gateway-ingress/agents/${agentId}/gateways`,
      {
        body: { ...baseCtx, provider: "feishu", loginId, config: {} },
      },
      h.responses,
    );
    expect(res.status).toBe(409);
    expect((res.body.error as { code: string }).code).toBe("login_unconfirmed");
  });

  it("rejects Feishu setup session access from a mismatched agent or user", async () => {
    const agentId = "ag_owner";
    const baseCtx = { user_id: "owner", hosting_kind: "cloud" } as const;
    const start = await call(
      h.url,
      `/internal/gateway-ingress/agents/${agentId}/gateways/feishu/login/start`,
      { body: { ...baseCtx } },
      h.responses,
    );
    const loginId = start.body.loginId as string;

    const wrongStatus = await call(
      h.url,
      `/internal/gateway-ingress/agents/${agentId}/gateways/feishu/login/status`,
      { body: { user_id: "intruder", hosting_kind: "cloud", loginId } },
      h.responses,
    );
    expect(wrongStatus.status).toBe(401);
    expect((wrongStatus.body.error as { code: string }).code).toBe("unauthorized");

    h.state.phase = "confirmed";
    const confirmed = await call(
      h.url,
      `/internal/gateway-ingress/agents/${agentId}/gateways/feishu/login/status`,
      { body: { ...baseCtx, loginId } },
      h.responses,
    );
    expect(confirmed.status).toBe(200);

    const wrongAgentDiscover = await call(
      h.url,
      `/internal/gateway-ingress/agents/ag_other/gateways/feishu/discover`,
      { body: { ...baseCtx, loginId, timeoutSeconds: 0 } },
      h.responses,
    );
    expect(wrongAgentDiscover.status).toBe(401);
    expect((wrongAgentDiscover.body.error as { code: string }).code).toBe("unauthorized");

    const wrongUserFinalize = await call(
      h.url,
      `/internal/gateway-ingress/agents/${agentId}/gateways`,
      {
        body: {
          user_id: "intruder",
          hosting_kind: "cloud",
          provider: "feishu",
          loginId,
          config: {},
        },
      },
      h.responses,
    );
    expect(wrongUserFinalize.status).toBe(401);
    expect((wrongUserFinalize.body.error as { code: string }).code).toBe("unauthorized");
  });

  it("returns provider_unreachable when Feishu discovery websocket start fails", async () => {
    await h.server.close();
    rmSync(h.dir, { recursive: true, force: true });
    h = await buildHarness({
      feishuSdkOverride: {
        createDispatcher: () => ({ register: () => {} }),
        createWsClient: () => ({
          start: () => Promise.reject(new Error("ws start failed")),
          close: () => {},
        }),
      },
    });
    const agentId = "ag_fs_ws_start_fail";
    const baseCtx = { user_id: "u", hosting_kind: "cloud" } as const;
    const start = await call(
      h.url,
      `/internal/gateway-ingress/agents/${agentId}/gateways/feishu/login/start`,
      { body: { ...baseCtx } },
      h.responses,
    );
    const loginId = start.body.loginId as string;
    h.state.phase = "confirmed";
    await call(
      h.url,
      `/internal/gateway-ingress/agents/${agentId}/gateways/feishu/login/status`,
      { body: { ...baseCtx, loginId } },
      h.responses,
    );

    const discover = await call(
      h.url,
      `/internal/gateway-ingress/agents/${agentId}/gateways/feishu/discover`,
      { body: { ...baseCtx, loginId, timeoutSeconds: 0 } },
      h.responses,
    );

    expect(discover.status).toBe(502);
    expect((discover.body.error as { code: string }).code).toBe("provider_unreachable");
    expect(JSON.stringify(discover.body)).not.toContain(FAKE_APP_SECRET);
  });

  it("returns gateway_conflict when the same appId is already owned by an active gateway", async () => {
    const agentId = "ag_first";
    const baseCtx = { user_id: "u", hosting_kind: "cloud" } as const;
    // First registration: success.
    const startA = await call(
      h.url,
      `/internal/gateway-ingress/agents/${agentId}/gateways/feishu/login/start`,
      { body: { ...baseCtx } },
      h.responses,
    );
    const loginA = startA.body.loginId as string;
    h.state.phase = "confirmed";
    await call(
      h.url,
      `/internal/gateway-ingress/agents/${agentId}/gateways/feishu/login/status`,
      { body: { ...baseCtx, loginId: loginA } },
      h.responses,
    );
    const finalizeA = await call(
      h.url,
      `/internal/gateway-ingress/agents/${agentId}/gateways`,
      { body: { ...baseCtx, provider: "feishu", loginId: loginA, config: {} } },
      h.responses,
    );
    expect(finalizeA.status).toBe(200);

    // Second registration: same appId — must be rejected.
    const agentB = "ag_second";
    const startB = await call(
      h.url,
      `/internal/gateway-ingress/agents/${agentB}/gateways/feishu/login/start`,
      { body: { ...baseCtx } },
      h.responses,
    );
    const loginB = startB.body.loginId as string;
    await call(
      h.url,
      `/internal/gateway-ingress/agents/${agentB}/gateways/feishu/login/status`,
      { body: { ...baseCtx, loginId: loginB } },
      h.responses,
    );
    const conflict = await call(
      h.url,
      `/internal/gateway-ingress/agents/${agentB}/gateways`,
      { body: { ...baseCtx, provider: "feishu", loginId: loginB, config: {} } },
      h.responses,
    );
    expect(conflict.status).toBe(409);
    expect((conflict.body.error as { code: string }).code).toBe("gateway_conflict");

    // SECRET-LEAK GUARD applies across all error paths too.
    for (const raw of h.responses) {
      expect(raw).not.toContain(FAKE_APP_SECRET);
    }
  });
});
