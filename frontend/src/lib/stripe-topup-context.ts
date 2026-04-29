/**
 * [INPUT]: 依赖浏览器 localStorage 暂存 Stripe checkout 期间的钱包 owner 上下文
 * [OUTPUT]: 对外提供 saveStripeTopupContext / readStripeTopupContext / clearStripeTopupContext，把发起 topup 时的 viewer 信息透传到 Stripe 跳转返回后的 session-status 轮询
 * [POS]: 解决跨 Stripe redirect 的状态丢失：发起方钱包归属在 redirect 前已知（来自 wallet store 的 viewer），但回到页面时 URL 只带了 session_id，需要复原 viewer 才能正确轮询
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

import type { ActiveIdentity } from "@/lib/api";

const STORAGE_KEY = "botcord_stripe_topup_contexts_v1";
const TTL_MS = 30 * 60 * 1000; // 30 min — Stripe checkout sessions expire in this range

interface StoredEntry {
  viewer: ActiveIdentity | null;
  ts: number;
}

type ContextMap = Record<string, StoredEntry>;

function readMap(): ContextMap {
  if (typeof window === "undefined") return {};
  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed as ContextMap;
  } catch {
    // fall through to {} — corrupted entries are harmless beyond a missed
    // refetch; the next save will overwrite.
  }
  return {};
}

function writeMap(map: ContextMap): void {
  if (typeof window === "undefined") return;
  // Drop expired entries on every write so the bag doesn't grow.
  const now = Date.now();
  const pruned: ContextMap = {};
  for (const [k, v] of Object.entries(map)) {
    if (now - v.ts < TTL_MS) pruned[k] = v;
  }
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(pruned));
  } catch {
    // localStorage may be full / unavailable; non-fatal.
  }
}

/** Remember the viewer that started this Stripe checkout session. */
export function saveStripeTopupContext(sessionId: string, viewer: ActiveIdentity | null): void {
  if (!sessionId) return;
  const map = readMap();
  map[sessionId] = { viewer: viewer ?? null, ts: Date.now() };
  writeMap(map);
}

/** Look up the viewer that started a Stripe session. ``null`` means "follow global identity". */
export function readStripeTopupContext(sessionId: string): ActiveIdentity | null {
  if (!sessionId) return null;
  const map = readMap();
  const entry = map[sessionId];
  if (!entry) return null;
  if (Date.now() - entry.ts >= TTL_MS) {
    delete map[sessionId];
    writeMap(map);
    return null;
  }
  return entry.viewer;
}

/** Drop the entry once polling resolves so localStorage doesn't accumulate. */
export function clearStripeTopupContext(sessionId: string): void {
  if (!sessionId) return;
  const map = readMap();
  if (sessionId in map) {
    delete map[sessionId];
    writeMap(map);
  }
}
