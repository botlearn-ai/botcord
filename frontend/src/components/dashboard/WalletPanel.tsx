"use client";

import { useState, useEffect, useCallback } from "react";
import { useDashboard } from "./DashboardApp";
import LedgerList from "./LedgerList";
import TransferDialog from "./TransferDialog";
import TopupDialog from "./TopupDialog";
import WithdrawDialog from "./WithdrawDialog";

function formatCoinAmount(minorStr: string): string {
  const minor = parseInt(minorStr, 10);
  if (isNaN(minor)) return "0.00";
  const major = minor / 100;
  return major.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export default function WalletPanel() {
  const { state, dispatch, loadWallet, loadWalletLedger } = useDashboard();
  const [activeDialog, setActiveDialog] = useState<"transfer" | "topup" | "withdraw" | null>(null);

  const wallet = state.wallet;
  const view = state.walletView;

  // Load ledger when switching to ledger view
  useEffect(() => {
    if (view === "ledger" && state.walletLedger.length === 0) {
      loadWalletLedger();
    }
  }, [view]);

  const handleDialogSuccess = useCallback(() => {
    setActiveDialog(null);
    loadWallet();
    loadWalletLedger();
  }, [loadWallet, loadWalletLedger]);

  if (!wallet) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center bg-deep-black gap-3">
        {state.walletError ? (
          <>
            <div className="text-sm text-red-400">{state.walletError}</div>
            <button
              onClick={loadWallet}
              className="rounded border border-glass-border px-4 py-2 text-xs text-text-secondary hover:text-text-primary"
            >
              Retry
            </button>
          </>
        ) : (
          <div className="text-neon-cyan animate-pulse text-sm">Loading wallet...</div>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col bg-deep-black">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-glass-border px-6 py-4">
        <h2 className="text-lg font-semibold text-text-primary">Wallet</h2>
        <div className="flex gap-1">
          <button
            onClick={() => dispatch({ type: "SET_WALLET_VIEW", view: "overview" })}
            className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
              view === "overview"
                ? "bg-neon-cyan/15 text-neon-cyan"
                : "text-text-secondary hover:text-text-primary"
            }`}
          >
            Overview
          </button>
          <button
            onClick={() => dispatch({ type: "SET_WALLET_VIEW", view: "ledger" })}
            className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
              view === "ledger"
                ? "bg-neon-cyan/15 text-neon-cyan"
                : "text-text-secondary hover:text-text-primary"
            }`}
          >
            Ledger
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        {view === "overview" ? (
          <WalletOverview
            wallet={wallet}
            onTransfer={() => setActiveDialog("transfer")}
            onTopup={() => setActiveDialog("topup")}
            onWithdraw={() => setActiveDialog("withdraw")}
          />
        ) : (
          <LedgerList />
        )}
      </div>

      {/* Dialogs */}
      {activeDialog === "transfer" && (
        <TransferDialog
          onClose={() => setActiveDialog(null)}
          onSuccess={handleDialogSuccess}
        />
      )}
      {activeDialog === "topup" && (
        <TopupDialog
          onClose={() => setActiveDialog(null)}
          onSuccess={handleDialogSuccess}
        />
      )}
      {activeDialog === "withdraw" && (
        <WithdrawDialog
          onClose={() => setActiveDialog(null)}
          onSuccess={handleDialogSuccess}
          availableBalance={wallet.available_balance_minor}
        />
      )}
    </div>
  );
}

function WalletOverview({
  wallet,
  onTransfer,
  onTopup,
  onWithdraw,
}: {
  wallet: { available_balance_minor: string; locked_balance_minor: string; total_balance_minor: string; asset_code: string; updated_at: string };
  onTransfer: () => void;
  onTopup: () => void;
  onWithdraw: () => void;
}) {
  return (
    <div className="mx-auto max-w-2xl space-y-6">
      {/* Balance Card */}
      <div className="rounded-2xl border border-glass-border bg-glass-bg p-6 backdrop-blur-xl">
        <div className="mb-1 text-xs font-medium uppercase tracking-wider text-text-secondary">
          Total Balance
        </div>
        <div className="mb-4 flex items-baseline gap-2">
          <span className="font-mono text-4xl font-bold text-text-primary">
            {formatCoinAmount(wallet.total_balance_minor)}
          </span>
          <span className="text-sm font-medium text-text-secondary">{wallet.asset_code}</span>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div className="rounded-xl border border-glass-border bg-deep-black-light p-4">
            <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-text-secondary">
              Available
            </div>
            <div className="font-mono text-xl font-semibold text-neon-green">
              {formatCoinAmount(wallet.available_balance_minor)}
            </div>
          </div>
          <div className="rounded-xl border border-glass-border bg-deep-black-light p-4">
            <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-text-secondary">
              Locked
            </div>
            <div className="font-mono text-xl font-semibold text-text-secondary">
              {formatCoinAmount(wallet.locked_balance_minor)}
            </div>
          </div>
        </div>

        <div className="mt-3 text-right text-[10px] text-text-secondary/50">
          Updated {new Date(wallet.updated_at).toLocaleString()}
        </div>
      </div>

      {/* Quick Actions */}
      <div className="grid grid-cols-3 gap-3">
        <button
          onClick={onTopup}
          className="flex flex-col items-center gap-2 rounded-xl border border-glass-border bg-glass-bg p-4 transition-all hover:border-neon-green/30 hover:bg-neon-green/5"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-6 w-6 text-neon-green">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
          </svg>
          <span className="text-xs font-medium text-text-primary">Recharge</span>
        </button>

        <button
          onClick={onTransfer}
          className="flex flex-col items-center gap-2 rounded-xl border border-glass-border bg-glass-bg p-4 transition-all hover:border-neon-cyan/30 hover:bg-neon-cyan/5"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-6 w-6 text-neon-cyan">
            <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 21L3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5" />
          </svg>
          <span className="text-xs font-medium text-text-primary">Transfer</span>
        </button>

        <button
          onClick={onWithdraw}
          className="flex flex-col items-center gap-2 rounded-xl border border-glass-border bg-glass-bg p-4 transition-all hover:border-neon-purple/30 hover:bg-neon-purple/5"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-6 w-6 text-neon-purple">
            <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
          </svg>
          <span className="text-xs font-medium text-text-primary">Withdraw</span>
        </button>
      </div>
    </div>
  );
}
