/**
 * [INPUT]: 依赖 zustand 保存钱包域状态，依赖 @/lib/api 发起 wallet 相关 BFF 请求，依赖主 dashboard store 提供 token/activeAgent
 * [OUTPUT]: 对外提供 useDashboardWalletStore 钱包域状态仓库与资金相关异步动作
 * [POS]: frontend dashboard 的钱包业务模块 store，独立管理余额、流水、提现请求与钱包视图
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

import { create } from "zustand";
import type { WalletLedgerEntry, WalletSummary, WithdrawalResponse } from "@/lib/types";
import { api } from "@/lib/api";
import { useDashboardSessionStore } from "@/store/useDashboardSessionStore";

interface DashboardWalletState {
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

  setWalletView: (view: DashboardWalletState["walletView"]) => void;
  resetWalletState: () => void;
  loadWallet: () => Promise<void>;
  loadWalletLedger: (loadMore?: boolean) => Promise<void>;
  loadWithdrawalRequests: () => Promise<void>;
}

const initialWalletState = {
  wallet: null,
  walletLedger: [],
  walletLedgerHasMore: false,
  walletLedgerCursor: null,
  walletLoading: false,
  walletError: null,
  walletLedgerError: null,
  withdrawalRequests: [],
  withdrawalRequestsLoading: false,
  withdrawalRequestsError: null,
  withdrawalRequestsLoaded: false,
  walletView: "overview" as const,
};

function getAuthContext() {
  const { token, activeAgentId } = useDashboardSessionStore.getState();
  return {
    token,
    hasReadyAgent: Boolean(token && activeAgentId),
  };
}

export const useDashboardWalletStore = create<DashboardWalletState>()((set, get) => ({
  ...initialWalletState,

  setWalletView: (view) => set({ walletView: view }),

  resetWalletState: () => set({ ...initialWalletState }),

  loadWallet: async () => {
    const { token, hasReadyAgent } = getAuthContext();
    if (!token) return;
    if (!hasReadyAgent) {
      set({ wallet: null, walletError: null });
      return;
    }
    try {
      const wallet = await api.getWallet();
      set({ wallet, walletError: null });
    } catch (err: any) {
      set({ walletError: err.message || "Failed to load wallet" });
    }
  },

  loadWalletLedger: async (loadMore = false) => {
    const { token, hasReadyAgent } = getAuthContext();
    const { walletLedgerCursor, walletLedger } = get();
    if (!token) return;
    if (!hasReadyAgent) {
      set({
        walletLedger: [],
        walletLedgerCursor: null,
        walletLedgerHasMore: false,
        walletLedgerError: null,
        walletLoading: false,
      });
      return;
    }
    set({ walletLoading: true });
    try {
      const cursor = loadMore ? walletLedgerCursor : undefined;
      const result = await api.getWalletLedger({ cursor: cursor ?? undefined, limit: 20 });
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
    } catch (err: any) {
      set({ walletLedgerError: err.message || "Failed to load ledger", walletLoading: false });
    }
  },

  loadWithdrawalRequests: async () => {
    const { token, hasReadyAgent } = getAuthContext();
    if (!token) return;
    if (!hasReadyAgent) {
      set({
        withdrawalRequests: [],
        withdrawalRequestsError: null,
        withdrawalRequestsLoaded: false,
        withdrawalRequestsLoading: false,
      });
      return;
    }
    set({ withdrawalRequestsLoading: true, withdrawalRequestsError: null });
    try {
      const result = await api.getWithdrawals();
      set({
        withdrawalRequests: result.withdrawals,
        withdrawalRequestsLoaded: true,
        withdrawalRequestsLoading: false,
      });
    } catch (err: any) {
      set({
        withdrawalRequestsError: err.message || "Failed to load withdrawals",
        withdrawalRequestsLoaded: true,
        withdrawalRequestsLoading: false,
      });
    }
  },
}));
