/**
 * Phase 4 migration covers all 3 providers: each test plants a fake daemon
 * profile + secret, runs dry-run, then --apply, and asserts:
 *   - ingress store + secret store land the expected shape
 *   - dry-run never writes
 *   - --force overrides an existing connection
 *   - --delete-after only fires under --apply
 *   - logger output never contains plaintext secrets
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { IngressLogger } from "../log.js";
import { FileSecretStore } from "../storage/secrets.js";
import { FileSystemIngressStore } from "../storage/store.js";
import { runMigrate, type MigrateOptions } from "../cli/migrate-from-daemon.js";

interface CapturedLog {
  level: "debug" | "info" | "warn" | "error";
  message: string;
  meta?: Record<string, unknown>;
}

function makeRecordingLogger(): { log: IngressLogger; lines: CapturedLog[]; raw: string } & {
  joined(): string;
} {
  const lines: CapturedLog[] = [];
  const ctx = {
    lines,
    raw: "",
    joined(): string {
      return lines
        .map((l) => `${l.level} ${l.message} ${JSON.stringify(l.meta ?? {})}`)
        .join("\n");
    },
    log: {
      debug(message: string, meta?: Record<string, unknown>) {
        lines.push({ level: "debug", message, ...(meta ? { meta } : {}) });
      },
      info(message: string, meta?: Record<string, unknown>) {
        lines.push({ level: "info", message, ...(meta ? { meta } : {}) });
      },
      warn(message: string, meta?: Record<string, unknown>) {
        lines.push({ level: "warn", message, ...(meta ? { meta } : {}) });
      },
      error(message: string, meta?: Record<string, unknown>) {
        lines.push({ level: "error", message, ...(meta ? { meta } : {}) });
      },
    } satisfies IngressLogger,
  };
  return ctx;
}

interface FakeDaemonLayout {
  rootDir: string;
  daemonDataDir: string;
  daemonConfigPath: string;
  ingressDataDir: string;
  ingressSecretDir: string;
}

function fakeDaemonLayout(): FakeDaemonLayout {
  const root = join(
    tmpdir(),
    `bgi-migrate-${process.pid}-${Math.random().toString(36).slice(2, 8)}`,
  );
  const daemonDataDir = join(root, "daemon", "gateways");
  const ingressDataDir = join(root, "ingress", "data");
  const ingressSecretDir = join(root, "ingress", "secrets");
  mkdirSync(daemonDataDir, { recursive: true });
  mkdirSync(ingressDataDir, { recursive: true });
  mkdirSync(ingressSecretDir, { recursive: true });
  return {
    rootDir: root,
    daemonDataDir,
    daemonConfigPath: join(root, "daemon", "config.json"),
    ingressDataDir,
    ingressSecretDir,
  };
}

function plantDaemonGateway(
  layout: FakeDaemonLayout,
  profile: {
    id: string;
    type: "telegram" | "wechat" | "feishu";
    accountId: string;
    label?: string;
    enabled?: boolean;
    allowedSenderIds?: string[];
    allowedChatIds?: string[];
    appId?: string;
    domain?: "feishu" | "lark";
    userOpenId?: string;
    baseUrl?: string;
  },
  secret: Record<string, unknown>,
  existingConfig: { thirdPartyGateways?: unknown[] } | null = null,
): void {
  const cfg = existingConfig ?? { thirdPartyGateways: [] };
  (cfg.thirdPartyGateways as unknown[]).push(profile);
  writeFileSync(layout.daemonConfigPath, JSON.stringify(cfg, null, 2));
  writeFileSync(
    join(layout.daemonDataDir, `${profile.id}.json`),
    JSON.stringify(secret, null, 2),
  );
  // Also drop a state file so --delete-after sees something to clean.
  writeFileSync(
    join(layout.daemonDataDir, `${profile.id}.state.json`),
    JSON.stringify({ cursor: "abc", updatedAt: new Date().toISOString() }),
  );
}

function baseOpts(
  layout: FakeDaemonLayout,
  logger: IngressLogger,
): MigrateOptions {
  return {
    daemonDataDir: layout.daemonDataDir,
    daemonConfigPath: layout.daemonConfigPath,
    apply: false,
    force: false,
    deleteAfter: false,
    quiet: false,
    storeOverride: new FileSystemIngressStore(layout.ingressDataDir),
    secretsOverride: new FileSecretStore(layout.ingressSecretDir),
    logOverride: logger,
    nowOverride: () => 1_700_000_000_000,
  };
}

describe("migrate-from-daemon", () => {
  let layout: FakeDaemonLayout;
  beforeEach(() => {
    layout = fakeDaemonLayout();
  });
  afterEach(() => {
    rmSync(layout.rootDir, { recursive: true, force: true });
  });

  it("dry-run does not write to ingress store/secrets", async () => {
    plantDaemonGateway(
      layout,
      {
        id: "gw_tg_001",
        type: "telegram",
        accountId: "ag_xyz",
        label: "tg-1",
        enabled: true,
        allowedChatIds: ["111"],
      },
      { botToken: "1234567890:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef" },
    );
    const cap = makeRecordingLogger();
    const summary = await runMigrate(baseOpts(layout, cap.log));
    expect(summary.migrated).toBe(0);
    expect(summary.skipped).toBe(1);
    expect(summary.failed).toBe(0);

    const store = new FileSystemIngressStore(layout.ingressDataDir);
    expect(store.getConnection("gw_tg_001")).toBeNull();

    const secrets = new FileSecretStore(layout.ingressSecretDir);
    expect(secrets.load("gw_tg_001")).toBeNull();

    // Plaintext bot token never appears in any log line.
    expect(cap.joined()).not.toContain("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef");
  });

  it("--apply migrates telegram secret + connection", async () => {
    plantDaemonGateway(
      layout,
      {
        id: "gw_tg_001",
        type: "telegram",
        accountId: "ag_xyz",
        label: "tg-1",
        enabled: true,
        allowedChatIds: ["111", "222"],
        baseUrl: "https://api.telegram.org",
      },
      { botToken: "tok_telegram_secret_value" },
    );
    const cap = makeRecordingLogger();
    const opts = baseOpts(layout, cap.log);
    opts.apply = true;
    const summary = await runMigrate(opts);
    expect(summary.migrated).toBe(1);
    expect(summary.skipped).toBe(0);
    expect(summary.failed).toBe(0);

    const store = new FileSystemIngressStore(layout.ingressDataDir);
    const conn = store.getConnection("gw_tg_001");
    expect(conn?.provider).toBe("telegram");
    expect(conn?.agentId).toBe("ag_xyz");
    expect(conn?.enabled).toBe(true);
    expect(conn?.config.allowedChatIds).toEqual(["111", "222"]);
    expect(conn?.config.baseUrl).toBe("https://api.telegram.org");
    expect(conn?.secretRef).toBe("gw_tg_001");

    const secrets = new FileSecretStore(layout.ingressSecretDir);
    const sec = secrets.load<{ botToken?: string; baseUrl?: string }>("gw_tg_001");
    expect(sec?.botToken).toBe("tok_telegram_secret_value");
    expect(sec?.baseUrl).toBe("https://api.telegram.org");

    // Plaintext bot token never appears in any log line.
    expect(cap.joined()).not.toContain("tok_telegram_secret_value");
  });

  it("--apply migrates wechat secret + connection", async () => {
    plantDaemonGateway(
      layout,
      {
        id: "gw_wx_001",
        type: "wechat",
        accountId: "ag_wx",
        enabled: true,
        allowedSenderIds: ["wxid_a"],
      },
      { botToken: "wx_token_value", baseUrl: "https://ilinkai.weixin.qq.com" },
    );
    const cap = makeRecordingLogger();
    const opts = baseOpts(layout, cap.log);
    opts.apply = true;
    const summary = await runMigrate(opts);
    expect(summary.migrated).toBe(1);

    const store = new FileSystemIngressStore(layout.ingressDataDir);
    const conn = store.getConnection("gw_wx_001");
    expect(conn?.provider).toBe("wechat");
    expect(conn?.config.allowedSenderIds).toEqual(["wxid_a"]);
    expect(conn?.config.baseUrl).toBe("https://ilinkai.weixin.qq.com");

    const secrets = new FileSecretStore(layout.ingressSecretDir);
    const sec = secrets.load<{ botToken?: string }>("gw_wx_001");
    expect(sec?.botToken).toBe("wx_token_value");
    expect(cap.joined()).not.toContain("wx_token_value");
  });

  it("--apply migrates feishu secret + connection (appId pulled from daemon config)", async () => {
    plantDaemonGateway(
      layout,
      {
        id: "gw_fs_001",
        type: "feishu",
        accountId: "ag_fs",
        enabled: true,
        appId: "cli_app_id_123",
        domain: "feishu",
        userOpenId: "ou_open_id",
        allowedChatIds: ["oc_chat_a"],
      },
      { appSecret: "fs_secret_value" },
    );
    const cap = makeRecordingLogger();
    const opts = baseOpts(layout, cap.log);
    opts.apply = true;
    const summary = await runMigrate(opts);
    expect(summary.migrated).toBe(1);

    const store = new FileSystemIngressStore(layout.ingressDataDir);
    const conn = store.getConnection("gw_fs_001");
    expect(conn?.provider).toBe("feishu");
    expect(conn?.config.domain).toBe("feishu");
    expect(conn?.config.userOpenId).toBe("ou_open_id");
    expect(conn?.config.allowedChatIds).toEqual(["oc_chat_a"]);

    const secrets = new FileSecretStore(layout.ingressSecretDir);
    const sec = secrets.load<{ appId?: string; appSecret?: string; domain?: string }>(
      "gw_fs_001",
    );
    expect(sec?.appId).toBe("cli_app_id_123");
    expect(sec?.appSecret).toBe("fs_secret_value");
    expect(sec?.domain).toBe("feishu");

    expect(cap.joined()).not.toContain("fs_secret_value");
  });

  it("skips when ingress already has the connection, unless --force is passed", async () => {
    plantDaemonGateway(
      layout,
      {
        id: "gw_tg_002",
        type: "telegram",
        accountId: "ag_xyz",
        enabled: true,
      },
      { botToken: "token_old" },
    );
    const cap = makeRecordingLogger();
    const opts = baseOpts(layout, cap.log);
    opts.apply = true;
    await runMigrate(opts);

    // Re-plant with a new token but same id.
    writeFileSync(
      join(layout.daemonDataDir, "gw_tg_002.json"),
      JSON.stringify({ botToken: "token_new" }),
    );

    const cap2 = makeRecordingLogger();
    const opts2 = baseOpts(layout, cap2.log);
    opts2.apply = true;
    const summary = await runMigrate(opts2);
    expect(summary.migrated).toBe(0);
    expect(summary.skipped).toBe(1);

    // --force flips it.
    const cap3 = makeRecordingLogger();
    const opts3 = baseOpts(layout, cap3.log);
    opts3.apply = true;
    opts3.force = true;
    const summary3 = await runMigrate(opts3);
    expect(summary3.migrated).toBe(1);

    const secrets = new FileSecretStore(layout.ingressSecretDir);
    const sec = secrets.load<{ botToken?: string }>("gw_tg_002");
    expect(sec?.botToken).toBe("token_new");
  });

  it("--delete-after removes daemon secret + state only on apply success", async () => {
    plantDaemonGateway(
      layout,
      {
        id: "gw_tg_003",
        type: "telegram",
        accountId: "ag_xyz",
        enabled: true,
      },
      { botToken: "token_value" },
    );
    const secretFile = join(layout.daemonDataDir, "gw_tg_003.json");
    const stateFile = join(layout.daemonDataDir, "gw_tg_003.state.json");
    expect(existsSync(secretFile)).toBe(true);
    expect(existsSync(stateFile)).toBe(true);

    // dry-run + delete-after must NOT delete.
    const cap1 = makeRecordingLogger();
    const opts1 = baseOpts(layout, cap1.log);
    opts1.deleteAfter = true;
    await runMigrate(opts1);
    expect(existsSync(secretFile)).toBe(true);
    expect(existsSync(stateFile)).toBe(true);

    // apply + delete-after MUST delete.
    const cap2 = makeRecordingLogger();
    const opts2 = baseOpts(layout, cap2.log);
    opts2.apply = true;
    opts2.deleteAfter = true;
    const summary = await runMigrate(opts2);
    expect(summary.migrated).toBe(1);
    expect(existsSync(secretFile)).toBe(false);
    expect(existsSync(stateFile)).toBe(false);
  });

  it("fails gracefully when daemon config has no matching profile", async () => {
    // Write a secret file but no matching thirdPartyGateways entry.
    writeFileSync(layout.daemonConfigPath, JSON.stringify({ thirdPartyGateways: [] }));
    writeFileSync(
      join(layout.daemonDataDir, "gw_orphan.json"),
      JSON.stringify({ botToken: "tok" }),
    );
    const cap = makeRecordingLogger();
    const opts = baseOpts(layout, cap.log);
    opts.apply = true;
    const summary = await runMigrate(opts);
    expect(summary.migrated).toBe(0);
    expect(summary.skipped).toBe(1);
    expect(summary.results[0]?.reason).toBe("no_profile_in_daemon_config");
  });
});
