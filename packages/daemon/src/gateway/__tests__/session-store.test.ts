import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionStore, sessionKey } from "../session-store.js";
import type { GatewaySessionEntry } from "../types.js";

let tmpDir = "";
let storePath = "";

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "gateway-session-"));
  storePath = path.join(tmpDir, "nested", "sessions.json");
});

afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

function baseEntry(overrides: Partial<GatewaySessionEntry> = {}): GatewaySessionEntry {
  return {
    key: "claude-code:botcord:ag_xxx:direct:rm_oc_abc",
    runtime: "claude-code",
    runtimeSessionId: "rt-session-1",
    channel: "botcord",
    accountId: "ag_xxx",
    conversationKind: "direct",
    conversationId: "rm_oc_abc",
    threadId: null,
    cwd: "/tmp/cwd",
    updatedAt: Date.now(),
    ...overrides,
  };
}

describe("sessionKey", () => {
  it("formats a direct conversation without thread", () => {
    expect(
      sessionKey({
        runtime: "claude-code",
        channel: "botcord",
        accountId: "ag_xxx",
        conversationKind: "direct",
        conversationId: "rm_oc_abc",
      }),
    ).toBe("claude-code:botcord:ag_xxx:direct:rm_oc_abc");
  });

  it("formats a group conversation with thread", () => {
    expect(
      sessionKey({
        runtime: "codex",
        channel: "telegram",
        accountId: "default",
        conversationKind: "group",
        conversationId: "-10012345",
        threadId: "thread_99",
      }),
    ).toBe("codex:telegram:default:group:-10012345:thread_99");
  });

  it("treats threadId null or empty string as no trailing segment", () => {
    const inputs = [
      { threadId: null as string | null },
      { threadId: "" as string | null },
      { threadId: undefined },
    ];
    for (const extra of inputs) {
      expect(
        sessionKey({
          runtime: "gemini",
          channel: "wechat",
          accountId: "main",
          conversationKind: "direct",
          conversationId: "wxid_xxx",
          ...extra,
        }),
      ).toBe("gemini:wechat:main:direct:wxid_xxx");
    }
  });
});

describe("SessionStore", () => {
  it("load() on missing file starts empty", async () => {
    const store = new SessionStore({ path: storePath });
    await store.load();
    expect(store.get("anything")).toBeUndefined();
    expect(store.all()).toEqual([]);
  });

  it("set() then get() round-trips the entry", async () => {
    const store = new SessionStore({ path: storePath });
    await store.load();
    const entry = baseEntry();
    await store.set(entry);
    const got = store.get(entry.key);
    expect(got?.runtimeSessionId).toBe(entry.runtimeSessionId);
    expect(got?.cwd).toBe(entry.cwd);
  });

  it("set() refreshes updatedAt when caller passes 0 or NaN", async () => {
    const store = new SessionStore({ path: storePath });
    await store.load();
    const before = Date.now();
    await store.set(baseEntry({ key: "k1", updatedAt: 0 }));
    await store.set(baseEntry({ key: "k2", updatedAt: Number.NaN }));
    const a = store.get("k1")!;
    const b = store.get("k2")!;
    expect(a.updatedAt).toBeGreaterThanOrEqual(before);
    expect(b.updatedAt).toBeGreaterThanOrEqual(before);
  });

  it("set() preserves a valid caller-provided updatedAt", async () => {
    const store = new SessionStore({ path: storePath });
    await store.load();
    const pinned = 1_700_000_000_000;
    await store.set(baseEntry({ updatedAt: pinned }));
    expect(store.get("claude-code:botcord:ag_xxx:direct:rm_oc_abc")?.updatedAt).toBe(pinned);
  });

  it("persists across instances", async () => {
    const first = new SessionStore({ path: storePath });
    await first.load();
    await first.set(baseEntry({ runtimeSessionId: "persisted-sid" }));

    const second = new SessionStore({ path: storePath });
    await second.load();
    const got = second.get("claude-code:botcord:ag_xxx:direct:rm_oc_abc");
    expect(got?.runtimeSessionId).toBe("persisted-sid");
  });

  it("delete() removes the entry and persists", async () => {
    const store = new SessionStore({ path: storePath });
    await store.load();
    await store.set(baseEntry());
    await store.delete("claude-code:botcord:ag_xxx:direct:rm_oc_abc");
    expect(store.get("claude-code:botcord:ag_xxx:direct:rm_oc_abc")).toBeUndefined();

    const reloaded = new SessionStore({ path: storePath });
    await reloaded.load();
    expect(reloaded.all()).toEqual([]);
  });

  it("recovers from corrupt JSON and rewrites on next set()", async () => {
    const warnings: string[] = [];
    const log = {
      info: () => undefined,
      warn: (msg: string) => {
        warnings.push(msg);
      },
      error: () => undefined,
      debug: () => undefined,
    };
    const dir = path.dirname(storePath);
    mkdirSync(dir, { recursive: true });
    writeFileSync(storePath, "{not valid json", "utf8");

    const store = new SessionStore({ path: storePath, log });
    await expect(store.load()).resolves.toBeUndefined();
    expect(store.get("anything")).toBeUndefined();
    expect(warnings.length).toBeGreaterThan(0);

    await store.set(baseEntry({ runtimeSessionId: "after-corrupt" }));
    const parsed = JSON.parse(readFileSync(storePath, "utf8"));
    expect(parsed.version).toBe(1);
    expect(
      parsed.entries["claude-code:botcord:ag_xxx:direct:rm_oc_abc"].runtimeSessionId,
    ).toBe("after-corrupt");
  });

  it("leaves no .tmp files behind after set()", async () => {
    const store = new SessionStore({ path: storePath });
    await store.load();
    await store.set(baseEntry());
    const dir = path.dirname(storePath);
    const leftovers = readdirSync(dir).filter((name) => name.endsWith(".tmp"));
    expect(leftovers).toEqual([]);
  });

  it("serializes concurrent set() calls without data loss", async () => {
    const store = new SessionStore({ path: storePath });
    await store.load();
    const writes = Array.from({ length: 5 }, (_, i) =>
      store.set(
        baseEntry({
          key: `k_${i}`,
          runtimeSessionId: `sid_${i}`,
          updatedAt: 1_700_000_000_000 + i,
        }),
      ),
    );
    await Promise.all(writes);

    const reloaded = new SessionStore({ path: storePath });
    await reloaded.load();
    for (let i = 0; i < 5; i++) {
      expect(reloaded.get(`k_${i}`)?.runtimeSessionId).toBe(`sid_${i}`);
    }
    expect(reloaded.all()).toHaveLength(5);
  });
});
