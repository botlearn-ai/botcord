import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  loadUserAuth,
  saveUserAuth,
  userAuthFromTokenResponse,
  UserAuthManager,
  type UserAuthRecord,
} from "../user-auth.js";

describe("user-auth", () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "user-auth-"));
    file = path.join(dir, "user-auth.json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("saveUserAuth writes 0600 and loadUserAuth reads it back", () => {
    const record: UserAuthRecord = {
      version: 1,
      userId: "usr_1",
      daemonInstanceId: "dm_1",
      hubUrl: "https://hub.example",
      accessToken: "at",
      refreshToken: "rt",
      expiresAt: Date.now() + 60_000,
      loggedInAt: new Date().toISOString(),
    };
    saveUserAuth(record, file);
    const mode = statSync(file).mode & 0o777;
    expect(mode).toBe(0o600);
    const loaded = loadUserAuth(file);
    expect(loaded).toMatchObject({
      userId: "usr_1",
      daemonInstanceId: "dm_1",
      accessToken: "at",
      refreshToken: "rt",
    });
  });

  it("loadUserAuth returns null when the file is missing", () => {
    expect(loadUserAuth(file)).toBeNull();
  });

  it("loadUserAuth rejects files with world-readable bits", () => {
    writeFileSync(file, JSON.stringify({ userId: "x" }));
    chmodSync(file, 0o644);
    expect(() => loadUserAuth(file)).toThrow(/insecure permissions/);
  });

  it("userAuthFromTokenResponse turns expiresIn into an absolute expiresAt", () => {
    const now = Date.now();
    const rec = userAuthFromTokenResponse(
      {
        accessToken: "at",
        refreshToken: "rt",
        expiresIn: 3600,
        userId: "usr_1",
        daemonInstanceId: "dm_1",
        hubUrl: "https://hub.example",
      },
      { label: "macbook" },
    );
    expect(rec.label).toBe("macbook");
    expect(rec.expiresAt).toBeGreaterThanOrEqual(now + 3599 * 1000);
    expect(rec.expiresAt).toBeLessThanOrEqual(now + 3601 * 1000);
  });

  it("userAuthFromTokenResponse + saveUserAuth persists the label to disk (plan §11.2)", () => {
    // Mirrors what `runDeviceCodeFlow` does on an issued token: build a
    // record with the `--label` from CLI and write it to the user-auth file.
    // Regression guard — we had a P1 gap where `--label` was captured on the
    // WS query string but never survived across restarts.
    const rec = userAuthFromTokenResponse(
      {
        accessToken: "at",
        refreshToken: "rt",
        expiresIn: 3600,
        userId: "usr_1",
        daemonInstanceId: "dm_1",
        hubUrl: "https://hub.example",
      },
      { label: "MacBook Pro" },
    );
    saveUserAuth(rec, file);
    const reloaded = loadUserAuth(file);
    expect(reloaded?.label).toBe("MacBook Pro");
  });

  it("userAuthFromTokenResponse omits label when not provided", () => {
    const rec = userAuthFromTokenResponse({
      accessToken: "at",
      refreshToken: "rt",
      expiresIn: 3600,
      userId: "usr_1",
      daemonInstanceId: "dm_1",
      hubUrl: "https://hub.example",
    });
    expect(rec.label).toBeUndefined();
  });

  it("UserAuthManager.ensureAccessToken returns the cached token when fresh", async () => {
    const record: UserAuthRecord = {
      version: 1,
      userId: "usr_1",
      daemonInstanceId: "dm_1",
      hubUrl: "https://hub.example",
      accessToken: "cached",
      refreshToken: "rt",
      expiresAt: Date.now() + 10 * 60_000,
      loggedInAt: new Date().toISOString(),
    };
    const mgr = new UserAuthManager({ record, file });
    expect(await mgr.ensureAccessToken()).toBe("cached");
  });
});
