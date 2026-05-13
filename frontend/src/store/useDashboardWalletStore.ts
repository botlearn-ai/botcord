/**
 * [INPUT]: 依赖 zustand 保存钱包域状态，依赖 @/lib/api 发起 wallet 相关 BFF 请求，依赖主 dashboard store 提供 token/active identity/owned agents
 * [OUTPUT]: 对外提供 useDashboardWalletStore — 跨账户(人 + 每只自有 bot)钱包域状态仓库与合并交易记录分页
 * [POS]: frontend dashboard 钱包业务模块 store。新结构以「总览」为主：fan-out 拉每个账户余额 + 合并交易记录；旧的 walletViewer 单视角接口保留给 dialog 临时态使用
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

import { create } from "zustand";
import type { ActiveIdentity } from "@/lib/api";
import type { WalletLedgerEntry, WalletSummary, WithdrawalResponse } from "@/lib/types";
import { api } from "@/lib/api";
import { useDashboardSessionStore } from "@/store/useDashboardSessionStore";

/**
 * Annotated ledger entry carries the account it belongs to so the unified
 * "最近交易" list can show "我 / Alpha / Beta" next to each row.
 */
export interface MergedLedgerEntry extends WalletLedgerEntry {
  _account: ActiveIdentity & { display_name: string };
}

interface AccountLedgerBuffer {
  entries: WalletLedgerEntry[];
  cursor: string | null;
  hasMore: boolean;
  done: boolean; // true once we've exhausted this account's ledger
}

interface DashboardWalletState {
  // --- Multi-account state (overview) ---
  humanWallet: WalletSummary | null;
  botWallets: Record<string, WalletSummary | null>;
  walletsLoading: boolean;
  walletsLoaded: boolean;
  walletsError: string | null;

  // Merged ledger across all owned accounts.
  mergedLedger: MergedLedgerEntry[];
  mergedLedgerLoading: boolean;
  mergedLedgerError: string | null;
  mergedLedgerHasMore: boolean;
  /** Per-account paging buffers — internal, but stored on the store for HMR safety. */
  ledgerBuffers: Record<string, AccountLedgerBuffer>;

  // --- Per-viewer state (kept for dialogs + bot drawer wallet tab) ---
  wallet: WalletSummary | null;
  walletLedger: WalletLedgerEntry[];
  walletLedgerHasMore: boolean;
  walletLedgerCursor: string | null;
  walletLoading: boolean;
  walletError: string | null;
  walletLedgerError: string | null;
  withdrawalRequests: WithdrawalResponse[];
  withdrawalRequestsLoading: boolean;
  withdrawalRequestsError: string | null;
  withdrawalRequestsLoaded: boolean;
  walletView: "overview" | "ledger";
  walletViewer: ActiveIdentity | null;

  setWalletView: (view: DashboardWalletState["walletView"]) => void;
  setWalletViewer: (viewer: ActiveIdentity | null) => void;
  resetWalletState: () => void;

  loadAllWallets: () => Promise<void>;
  loadMergedLedger: (loadMore?: boolean) => Promise<void>;
  loadWallet: () => Promise<void>;
  loadWalletLedger: (loadMore?: boolean) => Promise<void>;
  loadWithdrawalRequests: () => Promise<void>;
}

const initialMultiState = {
  humanWallet: null as WalletSummary | null,
  botWallets: {} as Record<string, WalletSummary | null>,
  walletsLoading: false,
  walletsLoaded: false,
  walletsError: null as string | null,
  mergedLedger: [] as MergedLedgerEntry[],
  mergedLedgerLoading: false,
  mergedLedgerError: null as string | null,
  mergedLedgerHasMore: false,
  ledgerBuffers: {} as Record<string, AccountLedgerBuffer>,
};

const initialPerViewerState = {
  wallet: null as WalletSummary | null,
  walletLedger: [] as WalletLedgerEntry[],
  walletLedgerHasMore: false,
  walletLedgerCursor: null as string | null,
  walletLoading: false,
  walletError: null as string | null,
  walletLedgerError: null as string | null,
  withdrawalRequests: [] as WithdrawalResponse[],
  withdrawalRequestsLoading: false,
  withdrawalRequestsError: null as string | null,
  withdrawalRequestsLoaded: false,
  walletView: "overview" as const,
  walletViewer: null as ActiveIdentity | null,
};

function getToken(): string | null {
  return useDashboardSessionStore.getState().token;
}

function getOwnedAccounts(): Array<{ identity: ActiveIdentity; display_name: string }> {
  const session = useDashboardSessionStore.getState();
  const accounts: Array<{ identity: ActiveIdentity; display_name: string }> = [];
  if (session.human?.human_id) {
    accounts.push({
      identity: { type: "human", id: session.human.human_id },
      display_name: session.human.display_name || "我",
    });
  }
  for (const agent of session.ownedAgents) {
    accounts.push({
      identity: { type: "agent", id: agent.agent_id },
      display_name: agent.display_name,
    });
  }
  return accounts;
}

const MERGED_PAGE_SIZE = 20;

/**
 * Merge per-account buffers into a flat list sorted by created_at desc.
 * `cutCount` controls how many rows to keep from the head — when
 * incremental loading, we expand the cut as more entries arrive.
 */
function mergeBuffers(
  buffers: Record<string, AccountLedgerBuffer>,
  accountMeta: Record<string, MergedLedgerEntry["_account"]>,
): MergedLedgerEntry[] {
  const merged: MergedLedgerEntry[] = [];
  for (const [key, buf] of Object.entries(buffers)) {
    const meta = accountMeta[key];
    if (!meta) continue;
    for (const entry of buf.entries) {
      merged.push({ ...entry, _account: meta });
    }
  }
  merged.sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
  return merged;
}

/**
 * Decide whether any account still has rows we haven't fetched. We use this
 * to set `mergedLedgerHasMore` on the store.
 */
function anyAccountHasMore(buffers: Record<string, AccountLedgerBuffer>): boolean {
  for (const buf of Object.values(buffers)) {
    if (!buf.done && (buf.hasMore || buf.cursor)) return true;
  }
  return false;
}

export const useDashboardWalletStore = create<DashboardWalletState>()((set, get) => ({
  ...initialMultiState,
  ...initialPerViewerState,

  setWalletView: (view) => set({ walletView: view }),

  setWalletViewer: (viewer) => {
    // Per-viewer slice resets so the next bootstrap re-fetches; multi-account
    // slice is preserved (it backs the overview).
    set({
      ...initialPerViewerState,
      walletView: get().walletView,
      walletViewer: viewer,
    });
  },

  resetWalletState: () => set({ ...initialMultiState, ...initialPerViewerState }),

  // --- Multi-account loaders (overview) ---

  loadAllWallets: async () => {
    if (!getToken()) return;
    const accounts = getOwnedAccounts();
    if (accounts.length === 0) {
      set({ walletsLoaded: true, walletsError: null });
      return;
    }
    set({ walletsLoading: true, walletsError: null });
    try {
      const results = await Promise.all(
        accounts.map((a) =>
          api.getWallet(a.identity).then(
            (w) => ({ ok: true as const, account: a, wallet: w }),
            (err) => ({ ok: false as const, account: a, error: err }),
          ),
        ),
      );
      let humanWallet: WalletSummary | null = null;
      const botWallets: Record<string, WalletSummary | null> = {};
      let firstError: string | null = null;
      for (const r of results) {
        if (r.ok) {
          if (r.account.identity.type === "human") humanWallet = r.wallet;
          else botWallets[r.account.identity.id] = r.wallet;
        } else {
          firstError = firstError ?? (r.error?.message || "Failed to load wallet");
          if (r.account.identity.type !== "human") botWallets[r.account.identity.id] = null;
        }
      }
      set({
        humanWallet,
        botWallets,
        walletsLoaded: true,
        walletsLoading: false,
        walletsError: firstError,
      });
    } catch (err: unknown) {
      set({
        walletsLoading: false,
        walletsLoaded: true,
        walletsError: err instanceof Error ? err.message : "Failed to load wallets",
      });
    }
  },

  loadMergedLedger: async (loadMore = false) => {
    if (!getToken()) return;
    const accounts = getOwnedAccounts();
    if (accounts.length === 0) {
      set({ mergedLedger: [], mergedLedgerHasMore: false });
      return;
    }
    const accountMeta: Record<string, MergedLedgerEntry["_account"]> = {};
    for (const a of accounts) {
      accountMeta[a.identity.id] = { ...a.identity, display_name: a.display_name };
    }

    set({ mergedLedgerLoading: true, mergedLedgerError: null });

    // Snapshot or initialize buffers for each account.
    const prevBuffers = loadMore ? get().ledgerBuffers : {};
    const buffers: Record<string, AccountLedgerBuffer> = {};
    for (const a of accounts) {
      buffers[a.identity.id] = prevBuffers[a.identity.id] ?? {
        entries: [],
        cursor: null,
        hasMore: true,
        done: false,
      };
    }

    try {
      // Fan out: any account with hasMore (or first load) fetches its next page.
      const targets = accounts.filter((a) => {
        const buf = buffers[a.identity.id];
        return !buf.done && (buf.hasMore || !loadMore);
      });
      const results = await Promise.all(
        targets.map((a) => {
          const buf = buffers[a.identity.id];
          return api
            .getWalletLedger({
              cursor: buf.cursor ?? undefined,
              limit: MERGED_PAGE_SIZE,
              viewer: a.identity,
            })
            .then(
              (r) => ({ ok: true as const, key: a.identity.id, result: r }),
              (err) => ({ ok: false as const, key: a.identity.id, error: err }),
            );
        }),
      );
      let firstError: string | null = null;
      for (const r of results) {
        const buf = buffers[r.key];
        if (r.ok) {
          buf.entries = [...buf.entries, ...r.result.entries];
          buf.cursor = r.result.next_cursor;
          buf.hasMore = r.result.has_more;
          buf.done = !r.result.has_more;
        } else {
          firstError = firstError ?? (r.error?.message || "Failed to load ledger");
          buf.done = true;
        }
      }

      const merged = mergeBuffers(buffers, accountMeta);
      set({
        mergedLedger: merged,
        mergedLedgerHasMore: anyAccountHasMore(buffers),
        mergedLedgerLoading: false,
        mergedLedgerError: firstError,
        ledgerBuffers: buffers,
      });
    } catch (err: unknown) {
      set({
        mergedLedgerLoading: false,
        mergedLedgerError: err instanceof Error ? err.message : "Failed to load ledger",
      });
    }
  },

  // --- Per-viewer loaders (drawer + dialogs) ---

  loadWallet: async () => {
    if (!getToken()) return;
    const viewer = get().walletViewer;
    try {
      const wallet = await api.getWallet(viewer);
      set({ wallet, walletError: null });
    } catch (err: unknown) {
      set({ walletError: err instanceof Error ? err.message : "Failed to load wallet" });
    }
  },

  loadWalletLedger: async (loadMore = false) => {
    if (!getToken()) return;
    const { walletLedgerCursor, walletLedger, walletViewer } = get();
    set({ walletLoading: true });
    try {
      const cursor = loadMore ? walletLedgerCursor : undefined;
      const result = await api.getWalletLedger({
        cursor: cursor ?? undefined,
        limit: 20,
        viewer: walletViewer,
      });
      if (loadMore) {
        set({
          walletLedger: [...walletLedger, ...result.entries],
          walletLedgerHasMore: result.has_more,
          walletLedgerCursor: result.next_cursor,
          walletLoading: false,
        });
      } else {
        set({
          walletLedger: result.entries,
          walletLedgerHasMore: result.has_more,
          walletLedgerCursor: result.next_cursor,
          walletLoading: false,
        });
      }
    } catch (err: unknown) {
      set({
        walletLedgerError: err instanceof Error ? err.message : "Failed to load ledger",
        walletLoading: false,
      });
    }
  },

  loadWithdrawalRequests: async () => {
    if (!getToken()) return;
    const viewer = get().walletViewer;
    set({ withdrawalRequestsLoading: true, withdrawalRequestsError: null });
    try {
      const result = await api.getWithdrawals(viewer);
      set({
        withdrawalRequests: result.withdrawals,
        withdrawalRequestsLoaded: true,
        withdrawalRequestsLoading: false,
      });
    } catch (err: unknown) {
      set({
        withdrawalRequestsError: err instanceof Error ? err.message : "Failed to load withdrawals",
        withdrawalRequestsLoaded: true,
        withdrawalRequestsLoading: false,
      });
    }
  },
}));
