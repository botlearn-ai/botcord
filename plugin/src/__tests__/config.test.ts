import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it, expect } from "vitest";
import {
  resolveChannelConfig,
  resolveAccounts,
  resolveAccountConfig,
  isAccountConfigured,
  countAccounts,
  getSingleAccountModeError,
  SINGLE_ACCOUNT_ONLY_MESSAGE,
  displayPrefix,
} from "../config.js";
import { generateKeypair } from "../crypto.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

// ── resolveChannelConfig ─────────────────────────────────────────

describe("resolveChannelConfig", () => {
  it("extracts channels.botcord from config", () => {
    const cfg = { channels: { botcord: { hubUrl: "https://hub.test" } } };
    expect(resolveChannelConfig(cfg)).toEqual({ hubUrl: "https://hub.test" });
  });

  it("returns empty object for missing config", () => {
    expect(resolveChannelConfig({})).toEqual({});
    expect(resolveChannelConfig(undefined)).toEqual({});
    expect(resolveChannelConfig(null)).toEqual({});
  });
});

// ── resolveAccounts ──────────────────────────────────────────────

describe("resolveAccounts", () => {
  it("returns accounts map when multi-account config exists", () => {
    const channelCfg = {
      accounts: {
        main: { hubUrl: "https://hub.test", agentId: "ag_main" },
        backup: { hubUrl: "https://hub2.test", agentId: "ag_backup" },
      },
    };
    const result = resolveAccounts(channelCfg);
    expect(Object.keys(result)).toEqual(["main", "backup"]);
    expect(result.main.agentId).toBe("ag_main");
  });

  it("falls back to single-account 'default' when no accounts field", () => {
    const channelCfg = {
      hubUrl: "https://hub.test",
      agentId: "ag_single",
      keyId: "k_1",
      privateKey: "abc",
    };
    const result = resolveAccounts(channelCfg);
    expect(Object.keys(result)).toEqual(["default"]);
    expect(result.default.agentId).toBe("ag_single");
    expect(result.default.hubUrl).toBe("https://hub.test");
  });

  it("falls back to default for empty accounts map", () => {
    const channelCfg = { accounts: {}, hubUrl: "https://hub.test" };
    const result = resolveAccounts(channelCfg);
    expect(Object.keys(result)).toEqual(["default"]);
  });
});

// ── resolveAccountConfig ─────────────────────────────────────────

describe("resolveAccountConfig", () => {
  it("returns specific account by ID", () => {
    const cfg = {
      channels: {
        botcord: {
          accounts: {
            prod: { hubUrl: "https://prod.test", agentId: "ag_prod", keyId: "k_p", privateKey: "x" },
          },
        },
      },
    };
    const acct = resolveAccountConfig(cfg, "prod");
    expect(acct.agentId).toBe("ag_prod");
  });

  it("returns default account when no accountId specified", () => {
    const cfg = {
      channels: {
        botcord: { hubUrl: "https://hub.test", agentId: "ag_def" },
      },
    };
    const acct = resolveAccountConfig(cfg);
    expect(acct.agentId).toBe("ag_def");
  });

  it("returns first account when requested ID not found", () => {
    const cfg = {
      channels: {
        botcord: {
          accounts: {
            only: { agentId: "ag_only" },
          },
        },
      },
    };
    const acct = resolveAccountConfig(cfg, "missing");
    expect(acct.agentId).toBe("ag_only");
  });

  it("loads credentials from a referenced credentials file", () => {
    const keys = generateKeypair();
    const dir = mkdtempSync(path.join(os.tmpdir(), "botcord-config-test-"));
    tempDirs.push(dir);
    const credentialsFile = path.join(dir, "credentials.json");
    writeFileSync(credentialsFile, JSON.stringify({
      hubUrl: "https://hub.file",
      agentId: "ag_file",
      keyId: "k_file",
      privateKey: keys.privateKey,
      publicKey: keys.publicKey,
    }));

    const cfg = {
      channels: {
        botcord: {
          credentialsFile,
          deliveryMode: "polling",
        },
      },
    };

    const acct = resolveAccountConfig(cfg);
    expect(acct.hubUrl).toBe("https://hub.file");
    expect(acct.agentId).toBe("ag_file");
    expect(acct.keyId).toBe("k_file");
    expect(acct.privateKey).toBe(keys.privateKey);
    expect(acct.publicKey).toBe(keys.publicKey);
    expect(acct.deliveryMode).toBe("polling");
    expect(acct.credentialsFile).toBe(credentialsFile);
  });

  it("lets inline config override values loaded from credentials file", () => {
    const keys = generateKeypair();
    const dir = mkdtempSync(path.join(os.tmpdir(), "botcord-config-test-"));
    tempDirs.push(dir);
    const credentialsFile = path.join(dir, "credentials.json");
    writeFileSync(credentialsFile, JSON.stringify({
      hubUrl: "https://hub.file",
      agentId: "ag_file",
      keyId: "k_file",
      privateKey: keys.privateKey,
      publicKey: keys.publicKey,
    }));

    const cfg = {
      channels: {
        botcord: {
          credentialsFile,
          hubUrl: "https://hub.inline",
        },
      },
    };

    const acct = resolveAccountConfig(cfg);
    expect(acct.hubUrl).toBe("https://hub.inline");
    expect(acct.agentId).toBe("ag_file");
  });
});

// ── isAccountConfigured ──────────────────────────────────────────

describe("isAccountConfigured", () => {
  it("returns true when all required fields present", () => {
    expect(
      isAccountConfigured({
        hubUrl: "https://hub.test",
        agentId: "ag_123",
        keyId: "k_1",
        privateKey: "abc",
      }),
    ).toBe(true);
  });

  it("returns false when any required field is missing", () => {
    expect(isAccountConfigured({ hubUrl: "x", agentId: "ag_1", keyId: "k_1" })).toBe(false);
    expect(isAccountConfigured({ hubUrl: "x", agentId: "ag_1", privateKey: "x" })).toBe(false);
    expect(isAccountConfigured({ hubUrl: "x", keyId: "k_1", privateKey: "x" })).toBe(false);
    expect(isAccountConfigured({ agentId: "ag_1", keyId: "k_1", privateKey: "x" })).toBe(false);
  });

  it("returns false for empty config", () => {
    expect(isAccountConfigured({})).toBe(false);
  });
});

// ── countAccounts ────────────────────────────────────────────────

describe("countAccounts", () => {
  it("counts multi-account configs", () => {
    const cfg = {
      channels: {
        botcord: {
          accounts: { a: {}, b: {}, c: {} },
        },
      },
    };
    expect(countAccounts(cfg)).toBe(3);
  });

  it("returns 1 for single-account fallback", () => {
    const cfg = { channels: { botcord: { hubUrl: "https://hub.test" } } };
    expect(countAccounts(cfg)).toBe(1);
  });
});

// ── getSingleAccountModeError ───────────────────────────────────

describe("getSingleAccountModeError", () => {
  it("returns null for a single-account config", () => {
    const cfg = { channels: { botcord: { hubUrl: "https://hub.test" } } };
    expect(getSingleAccountModeError(cfg)).toBeNull();
  });

  it("returns the single-account guard message for multi-account configs", () => {
    const cfg = {
      channels: {
        botcord: {
          accounts: { a: {}, b: {} },
        },
      },
    };
    expect(getSingleAccountModeError(cfg)).toBe(SINGLE_ACCOUNT_ONLY_MESSAGE);
  });
});

// ── displayPrefix ────────────────────────────────────────────────

describe("displayPrefix", () => {
  it("returns 'BotCord' for single default account", () => {
    const cfg = { channels: { botcord: { hubUrl: "x" } } };
    expect(displayPrefix("default", cfg)).toBe("BotCord");
  });

  it("returns 'BotCord:<id>' for multi-account", () => {
    const cfg = {
      channels: {
        botcord: { accounts: { prod: {}, staging: {} } },
      },
    };
    expect(displayPrefix("prod", cfg)).toBe("BotCord:prod");
  });

  it("returns 'BotCord:<id>' for non-default single account", () => {
    const cfg = { channels: { botcord: { hubUrl: "x" } } };
    expect(displayPrefix("custom", cfg)).toBe("BotCord:custom");
  });
});
