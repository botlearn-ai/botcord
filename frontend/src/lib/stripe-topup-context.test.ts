/**
 * [INPUT]: 依赖 vitest 的伪 localStorage 与时间控制，验证 stripe-topup-context 的存取/过期/清理协议
 * [OUTPUT]: 对外提供 stripe-topup-context helper 的回归护栏，锁定 viewer 透传 Stripe redirect 的关键不变量
 * [POS]: frontend/lib 的纯函数测试，保证 wallet 多 owner 切换在跨 Stripe checkout 后仍能正确轮询
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const STORAGE_KEY = "botcord_stripe_topup_contexts_v1";
const TTL_MS = 30 * 60 * 1000;

// vitest.config.ts pins `environment: 'node'`, which has no `window`. The
// helper short-circuits when `window` is undefined, so we install a minimal
// localStorage-backed fake before importing the module under test, and
// re-import per test so each starts from a clean slate.
function installFakeWindow(): { storage: Record<string, string> } {
  const storage: Record<string, string> = {};
  (globalThis as unknown as { window: unknown }).window = {
    localStorage: {
      getItem: (k: string) => (k in storage ? storage[k] : null),
      setItem: (k: string, v: string) => { storage[k] = v; },
      removeItem: (k: string) => { delete storage[k]; },
      clear: () => { for (const k of Object.keys(storage)) delete storage[k]; },
    },
  };
  return { storage };
}

function uninstallFakeWindow() {
  delete (globalThis as unknown as { window?: unknown }).window;
}

async function loadModule() {
  // Force a fresh module so each test runs against the freshly-installed
  // fake window (the module reads `typeof window` once at use time, so this
  // isn't strictly required, but it isolates module-level caching if any
  // is ever introduced).
  vi.resetModules();
  return await import("./stripe-topup-context");
}

let storageRef: { storage: Record<string, string> };

beforeEach(() => {
  storageRef = installFakeWindow();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  uninstallFakeWindow();
});

describe("stripe-topup-context", () => {
  it("returns the saved viewer for a known sessionId", async () => {
    const { saveStripeTopupContext, readStripeTopupContext } = await loadModule();
    const viewer = { type: "agent" as const, id: "ag_test" };
    saveStripeTopupContext("cs_abc", viewer);

    expect(readStripeTopupContext("cs_abc")).toEqual(viewer);
  });

  it("returns null for an unknown sessionId", async () => {
    const { saveStripeTopupContext, readStripeTopupContext } = await loadModule();
    saveStripeTopupContext("cs_abc", { type: "human", id: "hu_x" });
    expect(readStripeTopupContext("cs_other")).toBeNull();
  });

  it("preserves null viewer (= follow global identity)", async () => {
    const { saveStripeTopupContext, readStripeTopupContext } = await loadModule();
    saveStripeTopupContext("cs_abc", null);
    // The helper returns the stored viewer directly, so a null viewer
    // resolves to null — the banner reads "no override → follow global".
    expect(readStripeTopupContext("cs_abc")).toBeNull();
    // The entry must still exist in storage; absence of an entry would
    // also produce null, but we want to verify the entry is *present*
    // so a follow-up clear could remove it.
    expect(storageRef.storage[STORAGE_KEY]).toContain("cs_abc");
  });

  it("clear removes the entry", async () => {
    const { saveStripeTopupContext, readStripeTopupContext, clearStripeTopupContext } = await loadModule();
    saveStripeTopupContext("cs_abc", { type: "agent", id: "ag_x" });
    clearStripeTopupContext("cs_abc");
    expect(readStripeTopupContext("cs_abc")).toBeNull();
    const raw = storageRef.storage[STORAGE_KEY] ?? "";
    expect(raw).not.toContain("cs_abc");
  });

  it("expired entries are returned as null and pruned", async () => {
    const { saveStripeTopupContext, readStripeTopupContext } = await loadModule();
    saveStripeTopupContext("cs_old", { type: "agent", id: "ag_x" });

    vi.advanceTimersByTime(TTL_MS + 1000);

    expect(readStripeTopupContext("cs_old")).toBeNull();
    const raw = storageRef.storage[STORAGE_KEY] ?? "";
    expect(raw).not.toContain("cs_old");
  });

  it("save prunes other expired entries to keep the bag bounded", async () => {
    const { saveStripeTopupContext } = await loadModule();
    saveStripeTopupContext("cs_old", { type: "agent", id: "ag_old" });

    vi.advanceTimersByTime(TTL_MS + 1000);

    saveStripeTopupContext("cs_new", { type: "agent", id: "ag_new" });

    const raw = storageRef.storage[STORAGE_KEY] ?? "";
    expect(raw).toContain("cs_new");
    expect(raw).not.toContain("cs_old");
  });

  it("tolerates corrupted JSON in localStorage", async () => {
    storageRef.storage[STORAGE_KEY] = "{not json";
    const { saveStripeTopupContext, readStripeTopupContext } = await loadModule();
    expect(readStripeTopupContext("cs_abc")).toBeNull();
    saveStripeTopupContext("cs_new", { type: "agent", id: "ag_new" });
    expect(readStripeTopupContext("cs_new")).toEqual({ type: "agent", id: "ag_new" });
  });

  it("save with empty sessionId is a no-op", async () => {
    const { saveStripeTopupContext } = await loadModule();
    saveStripeTopupContext("", { type: "agent", id: "ag_x" });
    expect(storageRef.storage[STORAGE_KEY]).toBeUndefined();
  });
});
