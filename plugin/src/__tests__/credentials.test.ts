/**
 * Tests for JWT token persistence in credentials.
 * Covers: reading token fields, updateCredentialsToken, attachTokenPersistence.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, afterEach } from "vitest";
import { generateKeypair } from "../crypto.js";
import {
  loadStoredCredentials,
  readCredentialFileData,
  writeCredentialsFile,
  updateCredentialsToken,
  attachTokenPersistence,
  type StoredBotCordCredentials,
} from "../credentials.js";
import { BotCordClient } from "../client.js";

const kp = generateKeypair();
const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "botcord-cred-test-"));
  tempDirs.push(dir);
  return dir;
}

function makeCredentials(overrides?: Partial<StoredBotCordCredentials>): StoredBotCordCredentials {
  return {
    version: 1,
    hubUrl: "https://api.botcord.chat",
    agentId: "ag_testcred01",
    keyId: "k_test",
    privateKey: kp.privateKey,
    publicKey: kp.publicKey,
    savedAt: new Date().toISOString(),
    ...overrides,
  };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

// ── loadStoredCredentials with token fields ──────────────────────

describe("loadStoredCredentials with token fields", () => {
  it("reads token and tokenExpiresAt from credentials file", () => {
    const dir = makeTempDir();
    const filePath = path.join(dir, "cred.json");
    const creds = makeCredentials({
      token: "jwt-cached-token",
      tokenExpiresAt: 1800000000,
    });
    writeFileSync(filePath, JSON.stringify(creds, null, 2));

    const loaded = loadStoredCredentials(filePath);
    expect(loaded.token).toBe("jwt-cached-token");
    expect(loaded.tokenExpiresAt).toBe(1800000000);
  });

  it("returns undefined token fields for legacy credentials without them", () => {
    const dir = makeTempDir();
    const filePath = path.join(dir, "cred.json");
    const { token, tokenExpiresAt, ...legacy } = makeCredentials();
    writeFileSync(filePath, JSON.stringify(legacy, null, 2));

    const loaded = loadStoredCredentials(filePath);
    expect(loaded.token).toBeUndefined();
    expect(loaded.tokenExpiresAt).toBeUndefined();
    // Core identity fields still work
    expect(loaded.agentId).toBe("ag_testcred01");
  });

  it("reads snake_case token_expires_at", () => {
    const dir = makeTempDir();
    const filePath = path.join(dir, "cred.json");
    const raw = { ...makeCredentials(), token_expires_at: 1900000000, token: "snake-tok" };
    delete (raw as any).tokenExpiresAt;
    writeFileSync(filePath, JSON.stringify(raw, null, 2));

    const loaded = loadStoredCredentials(filePath);
    expect(loaded.token).toBe("snake-tok");
    expect(loaded.tokenExpiresAt).toBe(1900000000);
  });
});

// ── readCredentialFileData ───────────────────────────────────────

describe("readCredentialFileData with token fields", () => {
  it("passes token and tokenExpiresAt into account config", () => {
    const dir = makeTempDir();
    const filePath = path.join(dir, "cred.json");
    writeCredentialsFile(filePath, makeCredentials({
      token: "file-token",
      tokenExpiresAt: 1800000000,
    }));

    const data = readCredentialFileData(filePath);
    expect(data.token).toBe("file-token");
    expect(data.tokenExpiresAt).toBe(1800000000);
  });
});

// ── writeCredentialsFile preserves token ─────────────────────────

describe("writeCredentialsFile", () => {
  it("preserves token fields and displayName on write", () => {
    const dir = makeTempDir();
    const filePath = path.join(dir, "cred.json");
    const creds = makeCredentials({
      displayName: "TestBot",
      token: "persisted-token",
      tokenExpiresAt: 1800000000,
    });

    writeCredentialsFile(filePath, creds);
    const raw = JSON.parse(readFileSync(filePath, "utf8"));
    expect(raw.token).toBe("persisted-token");
    expect(raw.tokenExpiresAt).toBe(1800000000);
    expect(raw.displayName).toBe("TestBot");
  });
});

// ── updateCredentialsToken ──────────────────────────────────────

describe("updateCredentialsToken", () => {
  it("atomically updates only token fields in existing file", () => {
    const dir = makeTempDir();
    const filePath = path.join(dir, "cred.json");
    const creds = makeCredentials({ displayName: "KeepMe" });
    writeCredentialsFile(filePath, creds);

    const ok = updateCredentialsToken(filePath, "new-jwt", 1900000000);
    expect(ok).toBe(true);

    const raw = JSON.parse(readFileSync(filePath, "utf8"));
    expect(raw.token).toBe("new-jwt");
    expect(raw.tokenExpiresAt).toBe(1900000000);
    // Other fields preserved
    expect(raw.displayName).toBe("KeepMe");
    expect(raw.agentId).toBe("ag_testcred01");
  });

  it("returns false for non-existent file", () => {
    const ok = updateCredentialsToken("/tmp/does-not-exist-cred-xyz.json", "tok", 123);
    expect(ok).toBe(false);
  });
});

// ── attachTokenPersistence ──────────────────────────────────────

describe("attachTokenPersistence", () => {
  it("does not set onTokenRefresh when no credentialsFile", () => {
    const client = new BotCordClient({
      hubUrl: "http://127.0.0.1:9999",
      agentId: "ag_x",
      keyId: "k_x",
      privateKey: kp.privateKey,
    });
    attachTokenPersistence(client, { agentId: "ag_x" });
    expect(client.onTokenRefresh).toBeUndefined();
  });

  it("sets onTokenRefresh that writes to credentialsFile", () => {
    const dir = makeTempDir();
    const filePath = path.join(dir, "cred.json");
    writeCredentialsFile(filePath, makeCredentials());

    const client = new BotCordClient({
      hubUrl: "http://127.0.0.1:9999",
      agentId: "ag_testcred01",
      keyId: "k_test",
      privateKey: kp.privateKey,
    });
    attachTokenPersistence(client, { credentialsFile: filePath });
    expect(client.onTokenRefresh).toBeDefined();

    // Simulate a refresh callback
    client.onTokenRefresh!("refreshed-jwt", 2000000000);

    const raw = JSON.parse(readFileSync(filePath, "utf8"));
    expect(raw.token).toBe("refreshed-jwt");
    expect(raw.tokenExpiresAt).toBe(2000000000);
    // Identity fields untouched
    expect(raw.agentId).toBe("ag_testcred01");
  });
});
