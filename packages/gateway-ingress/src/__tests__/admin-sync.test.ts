import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadConfigFromEnv } from "../config.js";
import { noopLogger } from "../log.js";
import { buildIngressService, type IngressService } from "../service.js";
import { MemorySecretStore } from "../storage/secrets.js";
import { FileSystemIngressStore } from "../storage/store.js";
import { FakeHubClient, FakeSocketFactory } from "./fixtures.js";

describe("admin sync server", () => {
  let dir: string;
  let service: IngressService;
  let starts: string[];
  let stops: string[];

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "ingress-admin-"));
    starts = [];
    stops = [];
    const config = loadConfigFromEnv({
      BOTCORD_INGRESS_HUB_URL: "http://test",
      BOTCORD_INGRESS_SECRET: "sync-secret",
      BOTCORD_INGRESS_DATA_DIR: dir,
      BOTCORD_INGRESS_SECRET_DIR: join(dir, "secrets"),
      BOTCORD_INGRESS_HEALTH_PORT: "0",
      BOTCORD_INGRESS_ADMIN_PORT: "0",
    });
    service = await buildIngressService({
      config,
      log: noopLogger,
      store: new FileSystemIngressStore(dir),
      secrets: new MemorySecretStore(),
      hub: new FakeHubClient(),
      socketFactory: new FakeSocketFactory().factory,
      startAdmin: true,
      factories: {
        telegram: (gatewayId) => ({
          gatewayId,
          provider: "telegram" as const,
          async start() {
            starts.push(gatewayId);
          },
          async stop(reason) {
            stops.push(`${gatewayId}:${reason}`);
          },
          async send() {
            return {};
          },
        }),
      },
    });
  });

  afterEach(async () => {
    await service.shutdown();
    rmSync(dir, { recursive: true, force: true });
  });

  function url(path: string): string {
    if (!service.admin) throw new Error("admin server not started");
    return `${service.admin.url}${path}`;
  }

  it("authenticates and stores connection metadata plus secrets", async () => {
    const unauthorized = await fetch(url("/admin/gateways/gw_tg_sync"), {
      method: "PUT",
      body: "{}",
    });
    expect(unauthorized.status).toBe(401);

    const res = await fetch(url("/admin/gateways/gw_tg_sync"), {
      method: "PUT",
      headers: {
        authorization: "Bearer sync-secret",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        id: "gw_tg_sync",
        agentId: "ag_cloud",
        userId: "user_1",
        provider: "telegram",
        label: "Cloud Telegram",
        enabled: true,
        status: "active",
        config: { allowedChatIds: ["111"], allowedSenderIds: ["111"] },
        secret: { botToken: "1234:abcd" },
      }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      gateway: { id: "gw_tg_sync", agentId: "ag_cloud", hasSecret: true },
    });
    expect(service.store.getConnection("gw_tg_sync")).toMatchObject({
      id: "gw_tg_sync",
      agentId: "ag_cloud",
      userId: "user_1",
      provider: "telegram",
      enabled: true,
      secretRef: "gw_tg_sync",
    });
    expect(service.secrets.load("gw_tg_sync")).toEqual({ botToken: "1234:abcd" });
    expect(starts).toEqual(["gw_tg_sync"]);
  });

  it("applies disabled updates and deletes local secret state", async () => {
    await fetch(url("/admin/gateways/gw_tg_sync"), {
      method: "PUT",
      headers: {
        authorization: "Bearer sync-secret",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        agentId: "ag_cloud",
        provider: "telegram",
        enabled: true,
        config: { allowedChatIds: ["111"], allowedSenderIds: ["111"] },
        secret: { botToken: "1234:abcd" },
      }),
    });
    await fetch(url("/admin/gateways/gw_tg_sync"), {
      method: "PUT",
      headers: {
        authorization: "Bearer sync-secret",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        agentId: "ag_cloud",
        provider: "telegram",
        enabled: false,
        status: "disabled",
        config: { allowedChatIds: ["111"], allowedSenderIds: ["222"] },
      }),
    });

    expect(service.store.getConnection("gw_tg_sync")).toMatchObject({
      enabled: false,
      status: "disabled",
      config: { allowedChatIds: ["111"], allowedSenderIds: ["222"] },
    });
    expect(service.secrets.load("gw_tg_sync")).toEqual({ botToken: "1234:abcd" });
    expect(stops).toContain("gw_tg_sync:admin-sync-disabled");

    const del = await fetch(url("/admin/gateways/gw_tg_sync"), {
      method: "DELETE",
      headers: { authorization: "Bearer sync-secret" },
    });
    expect(del.status).toBe(200);
    expect(service.store.getConnection("gw_tg_sync")).toBeNull();
    expect(service.secrets.load("gw_tg_sync")).toBeNull();
    // The disabled update already stopped the adapter; delete is still
    // responsible for removing persisted metadata and secret state.
    expect(stops).toContain("gw_tg_sync:admin-sync-disabled");
  });

  it("stores enabled gateways without starting providers until a secret is present", async () => {
    const res = await fetch(url("/admin/gateways/gw_feishu_sync"), {
      method: "PUT",
      headers: {
        authorization: "Bearer sync-secret",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        agentId: "ag_cloud",
        provider: "feishu",
        enabled: true,
        status: "pending",
        config: { allowedSenderIds: ["ou_1"] },
      }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      gateway: { id: "gw_feishu_sync", agentId: "ag_cloud", hasSecret: false },
    });
    expect(service.store.getConnection("gw_feishu_sync")).toMatchObject({
      id: "gw_feishu_sync",
      agentId: "ag_cloud",
      provider: "feishu",
      enabled: true,
      secretRef: "gw_feishu_sync",
    });
    expect(service.secrets.load("gw_feishu_sync")).toBeNull();
    expect(starts).toEqual([]);
  });
});
