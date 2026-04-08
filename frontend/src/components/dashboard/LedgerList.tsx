"use client";

/**
 * [INPUT]: 依赖钱包 store 提供账本 entry 列表，依赖 entry 上的交易元数据渲染来源与金额
 * [OUTPUT]: 对外提供 LedgerList 组件，负责展示钱包流水列表与分页加载入口
 * [POS]: dashboard/wallet 的账本明细视图，与 WalletPanel 配合呈现资金来源和去向
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

import { useShallow } from "zustand/react/shallow";
import { useDashboardWalletStore } from "@/store/useDashboardWalletStore";

function formatCoinAmount(minorStr: string): string {
  const minor = parseInt(minorStr, 10);
  if (isNaN(minor)) return "0.00";
  const major = minor / 100;
  return major.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatSourceLabel(entry: {
  tx_type?: string | null;
  reference_type?: string | null;
}): string {
  if (entry.reference_type === "agent_claim_gift") return "Claim gift";
  if (entry.tx_type === "grant") return "System grant";
  if (entry.tx_type === "transfer") return "Transfer";
  if (entry.tx_type === "topup") return "Top up";
  if (entry.tx_type === "withdrawal") return "Withdrawal";
  return "Transaction";
}

export default function LedgerList() {
  const { walletLedger, walletLedgerHasMore, walletLoading, walletLedgerError, loadWalletLedger } =
    useDashboardWalletStore(useShallow((state) => ({
      walletLedger: state.walletLedger,
      walletLedgerHasMore: state.walletLedgerHasMore,
      walletLoading: state.walletLoading,
      walletLedgerError: state.walletLedgerError,
      loadWalletLedger: state.loadWalletLedger,
    })));

  if (walletLoading && walletLedger.length === 0) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-neon-cyan animate-pulse text-sm">Loading ledger...</div>
      </div>
    );
  }

  if (walletLedgerError && walletLedger.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 gap-3">
        <div className="text-sm text-red-400">{walletLedgerError}</div>
        <button
          onClick={() => loadWalletLedger()}
          className="rounded border border-glass-border px-4 py-2 text-xs text-text-secondary hover:text-text-primary"
        >
          Retry
        </button>
      </div>
    );
  }

  if (walletLedger.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12">
        <div className="mb-2 text-2xl opacity-20">---</div>
        <p className="text-sm text-text-secondary">No transactions yet</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl space-y-2">
      {walletLedger.map((entry) => {
        const isCredit = entry.direction === "credit";
        const sourceLabel = formatSourceLabel(entry);
        return (
          <div
            key={entry.entry_id}
            className="flex items-center gap-3 rounded-xl border border-glass-border bg-glass-bg p-4 transition-colors hover:bg-glass-bg/80"
          >
            {/* Direction icon */}
            <div
              className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${
                isCredit ? "bg-neon-green/10 text-neon-green" : "bg-red-500/10 text-red-400"
              }`}
            >
              {isCredit ? (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 14l-7 7m0 0l-7-7m7 7V3" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 10l7-7m0 0l7 7m-7-7v18" />
                </svg>
              )}
            </div>

            {/* Details */}
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline justify-between">
                <div className="min-w-0">
                  <span className="text-xs font-medium text-text-primary capitalize">
                    {isCredit ? "Credit" : "Debit"}
                  </span>
                  <span className="ml-2 text-[10px] uppercase tracking-[0.18em] text-text-secondary/60">
                    {sourceLabel}
                  </span>
                </div>
                <span
                  className={`font-mono text-sm font-semibold ${
                    isCredit ? "text-neon-green" : "text-red-400"
                  }`}
                >
                  {isCredit ? "+" : "-"}{formatCoinAmount(entry.amount_minor)}
                </span>
              </div>
              <div className="flex items-baseline justify-between">
                <span className="truncate font-mono text-[10px] text-text-secondary/60">
                  {entry.tx_id}
                </span>
                <span className="ml-2 shrink-0 text-[10px] text-text-secondary/60">
                  Bal: {formatCoinAmount(entry.balance_after_minor)}
                </span>
              </div>
              <div className="mt-0.5 text-[10px] text-text-secondary/50">
                {formatTime(entry.created_at)}
              </div>
            </div>
          </div>
        );
      })}

      {/* Load more */}
      {walletLedgerHasMore && (
        <div className="flex justify-center pt-2">
          <button
            onClick={() => loadWalletLedger(true)}
            disabled={walletLoading}
            className="rounded-lg border border-glass-border px-4 py-2 text-xs font-medium text-text-secondary transition-colors hover:bg-glass-bg hover:text-text-primary disabled:opacity-40"
          >
            {walletLoading ? "Loading..." : "Load more"}
          </button>
        </div>
      )}
    </div>
  );
}
