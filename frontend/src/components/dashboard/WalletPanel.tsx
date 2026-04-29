"use client";

/**
 * [INPUT]: 依赖 wallet store 提供钱包状态，依赖钱包子组件完成资金操作
 * [OUTPUT]: 对外提供 WalletPanel 组件，负责余额概览与流水视图
 * [POS]: dashboard 钱包主面板，在已登录且已通过 agent 准入的上下文中渲染资金信息
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

import { useState, useEffect, useCallback, useMemo } from "react";
import { useLanguage } from '@/lib/i18n';
import { walletPanel } from '@/lib/i18n/translations/dashboard';
import { common } from '@/lib/i18n/translations/common';
import { api, ApiError, type ActiveIdentity } from "@/lib/api";
import type { WithdrawalResponse } from "@/lib/types";
import { useShallow } from "zustand/react/shallow";
import { ChevronDown, Loader2 } from "lucide-react";
import { useDashboardSessionStore } from "@/store/useDashboardSessionStore";
import { useDashboardWalletStore } from "@/store/useDashboardWalletStore";
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
  const locale = useLanguage();
  const t = walletPanel[locale];
  const tc = common[locale];
  const {
    wallet,
    walletView,
    walletError,
    walletLoading,
    walletLedger,
    walletViewer,
    withdrawalRequests,
    withdrawalRequestsLoading,
    withdrawalRequestsError,
    withdrawalRequestsLoaded,
    loadWallet,
    loadWalletLedger,
    loadWithdrawalRequests,
    setWalletView,
    setWalletViewer,
  } = useDashboardWalletStore(useShallow((state) => ({
    wallet: state.wallet,
    walletView: state.walletView,
    walletError: state.walletError,
    walletLoading: state.walletLoading,
    walletLedger: state.walletLedger,
    walletViewer: state.walletViewer,
    withdrawalRequests: state.withdrawalRequests,
    withdrawalRequestsLoading: state.withdrawalRequestsLoading,
    withdrawalRequestsError: state.withdrawalRequestsError,
    withdrawalRequestsLoaded: state.withdrawalRequestsLoaded,
    loadWallet: state.loadWallet,
    loadWalletLedger: state.loadWalletLedger,
    loadWithdrawalRequests: state.loadWithdrawalRequests,
    setWalletView: state.setWalletView,
    setWalletViewer: state.setWalletViewer,
  })));
  const sessionStore = useDashboardSessionStore(
    useShallow((s) => ({
      activeIdentity: s.activeIdentity,
      ownedAgents: s.ownedAgents,
      human: s.human,
    })),
  );
  const [activeDialog, setActiveDialog] = useState<"transfer" | "topup" | "withdraw" | null>(null);
  const view = walletView;

  // Effective viewer: explicit override, otherwise the global active identity.
  const effectiveViewer: ActiveIdentity | null = walletViewer ?? sessionStore.activeIdentity;
  const ownerOptions = useMemo(() => {
    const options: Array<{ identity: ActiveIdentity; label: string }> = [];
    if (sessionStore.human?.human_id) {
      options.push({
        identity: { type: "human", id: sessionStore.human.human_id },
        label: t.youHuman,
      });
    }
    for (const agent of sessionStore.ownedAgents) {
      options.push({
        identity: { type: "agent", id: agent.agent_id },
        label: `${t.botPrefix} · ${agent.display_name}`,
      });
    }
    return options;
  }, [sessionStore.human, sessionStore.ownedAgents, t.botPrefix, t.youHuman]);
  const showOwnerSwitcher = ownerOptions.length > 1;

  useEffect(() => {
    if (!wallet && !walletError && !walletLoading) {
      void loadWallet();
    }
  }, [wallet, walletError, walletLoading, loadWallet]);

  // Load ledger when switching to ledger view
  useEffect(() => {
    if (view === "ledger" && walletLedger.length === 0) {
      void loadWalletLedger();
    }
  }, [view, walletLedger.length, loadWalletLedger]);

  useEffect(() => {
    if (
      !withdrawalRequestsLoaded &&
      !withdrawalRequestsLoading &&
      !withdrawalRequestsError
    ) {
      void loadWithdrawalRequests();
    }
  }, [
    withdrawalRequestsLoaded,
    withdrawalRequestsLoading,
    withdrawalRequestsError,
    loadWithdrawalRequests,
  ]);

  const handleDialogSuccess = useCallback(() => {
    setActiveDialog(null);
    void loadWallet();
    void loadWalletLedger();
    void loadWithdrawalRequests();
  }, [loadWallet, loadWalletLedger, loadWithdrawalRequests]);

  if (!wallet) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center bg-deep-black gap-3">
        {walletError ? (
          <>
            <div className="text-sm text-red-400">{walletError}</div>
            <button
              onClick={() => void loadWallet()}
              className="rounded border border-glass-border px-4 py-2 text-xs text-text-secondary hover:text-text-primary"
            >
              {tc.retry}
            </button>
          </>
        ) : (
          <div className="text-neon-cyan animate-pulse text-sm">{tc.loading}</div>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col bg-deep-black">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-glass-border px-6 py-4">
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-semibold text-text-primary">{t.wallet}</h2>
          {showOwnerSwitcher ? (
            <WalletOwnerSwitcher
              effectiveViewer={effectiveViewer}
              options={ownerOptions}
              onSelect={(identity) => setWalletViewer(identity)}
              label={t.viewingWalletFor}
            />
          ) : null}
        </div>
        <div className="flex gap-1">
          <button
            onClick={() => setWalletView("overview")}
            className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
              view === "overview"
                ? "bg-neon-cyan/15 text-neon-cyan"
                : "text-text-secondary hover:text-text-primary"
            }`}
          >
            {t.overview}
          </button>
          <button
            onClick={() => setWalletView("ledger")}
            className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
              view === "ledger"
                ? "bg-neon-cyan/15 text-neon-cyan"
                : "text-text-secondary hover:text-text-primary"
            }`}
          >
            {t.ledger}
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        {view === "overview" ? (
          <WalletOverview
            wallet={wallet}
            viewer={effectiveViewer}
            withdrawalRequests={withdrawalRequests}
            withdrawalsLoading={withdrawalRequestsLoading}
            withdrawalsError={withdrawalRequestsError}
            onRefreshWithdrawals={loadWithdrawalRequests}
            onWithdrawalUpdated={handleDialogSuccess}
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
          viewer={effectiveViewer}
          onClose={() => setActiveDialog(null)}
          onSuccess={handleDialogSuccess}
        />
      )}
      {activeDialog === "topup" && (
        <TopupDialog
          viewer={effectiveViewer}
          onClose={() => setActiveDialog(null)}
          onSuccess={handleDialogSuccess}
        />
      )}
      {activeDialog === "withdraw" && (
        <WithdrawDialog
          viewer={effectiveViewer}
          onClose={() => setActiveDialog(null)}
          onSuccess={handleDialogSuccess}
          availableBalance={wallet.available_balance_minor}
        />
      )}
    </div>
  );
}

interface OwnerOption {
  identity: ActiveIdentity;
  label: string;
}

function WalletOwnerSwitcher({
  effectiveViewer,
  options,
  onSelect,
  label,
}: {
  effectiveViewer: ActiveIdentity | null;
  options: OwnerOption[];
  onSelect: (identity: ActiveIdentity) => void;
  label: string;
}) {
  const [open, setOpen] = useState(false);
  const current = effectiveViewer
    ? options.find(
        (o) => o.identity.type === effectiveViewer.type && o.identity.id === effectiveViewer.id,
      )
    : null;
  const display = current?.label ?? "—";

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        className="inline-flex items-center gap-1.5 rounded-lg border border-glass-border bg-glass-bg px-3 py-1.5 text-xs text-text-secondary hover:text-text-primary"
      >
        <span className="text-text-secondary/70">{label}</span>
        <span className="font-medium text-text-primary">{display}</span>
        <ChevronDown className="h-3.5 w-3.5" />
      </button>
      {open ? (
        <div className="absolute left-0 top-full z-20 mt-1 min-w-[200px] overflow-hidden rounded-lg border border-glass-border bg-deep-black-light shadow-lg">
          {options.map((opt) => {
            const selected =
              effectiveViewer?.type === opt.identity.type
              && effectiveViewer?.id === opt.identity.id;
            return (
              <button
                key={`${opt.identity.type}:${opt.identity.id}`}
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  onSelect(opt.identity);
                  setOpen(false);
                }}
                className={`flex w-full items-center justify-between px-3 py-2 text-left text-xs transition-colors hover:bg-glass-bg ${
                  selected ? "bg-neon-cyan/10 text-neon-cyan" : "text-text-primary"
                }`}
              >
                <span className="truncate">{opt.label}</span>
                <span className="ml-2 truncate font-mono text-[10px] text-text-secondary/60">
                  {opt.identity.id}
                </span>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function WalletOverview({
  wallet,
  viewer,
  withdrawalRequests,
  withdrawalsLoading,
  withdrawalsError,
  onRefreshWithdrawals,
  onWithdrawalUpdated,
  onTransfer,
  onTopup,
  onWithdraw,
}: {
  wallet: { available_balance_minor: string; locked_balance_minor: string; total_balance_minor: string; asset_code: string; updated_at: string };
  viewer: ActiveIdentity | null;
  withdrawalRequests: WithdrawalResponse[];
  withdrawalsLoading: boolean;
  withdrawalsError: string | null;
  onRefreshWithdrawals: () => void;
  onWithdrawalUpdated: () => void;
  onTransfer: () => void;
  onTopup: () => void;
  onWithdraw: () => void;
}) {
  const locale = useLanguage();
  const t = walletPanel[locale];

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      {/* Balance Card */}
      <div className="rounded-2xl border border-glass-border bg-glass-bg p-6 backdrop-blur-xl">
        <div className="mb-1 text-xs font-medium uppercase tracking-wider text-text-secondary">
          {t.totalBalance}
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
              {t.available}
            </div>
            <div className="font-mono text-xl font-semibold text-neon-green">
              {formatCoinAmount(wallet.available_balance_minor)}
            </div>
          </div>
          <div className="rounded-xl border border-glass-border bg-deep-black-light p-4">
            <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-text-secondary">
              {t.locked}
            </div>
            <div className="font-mono text-xl font-semibold text-text-secondary">
              {formatCoinAmount(wallet.locked_balance_minor)}
            </div>
          </div>
        </div>

        <div className="mt-3 text-right text-[10px] text-text-secondary/50">
          {t.updated} {new Date(wallet.updated_at).toLocaleString()}
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
          <span className="text-xs font-medium text-text-primary">{t.recharge}</span>
        </button>

        <button
          onClick={onTransfer}
          className="flex flex-col items-center gap-2 rounded-xl border border-glass-border bg-glass-bg p-4 transition-all hover:border-neon-cyan/30 hover:bg-neon-cyan/5"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-6 w-6 text-neon-cyan">
            <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 21L3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5" />
          </svg>
          <span className="text-xs font-medium text-text-primary">{t.transfer}</span>
        </button>

        <button
          onClick={onWithdraw}
          className="flex flex-col items-center gap-2 rounded-xl border border-glass-border bg-glass-bg p-4 transition-all hover:border-neon-purple/30 hover:bg-neon-purple/5"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-6 w-6 text-neon-purple">
            <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
          </svg>
          <span className="text-xs font-medium text-text-primary">{t.withdraw}</span>
        </button>
      </div>

      <RecentWithdrawals
        viewer={viewer}
        items={withdrawalRequests}
        loading={withdrawalsLoading}
        error={withdrawalsError}
        onRefresh={onRefreshWithdrawals}
        onCancelled={onWithdrawalUpdated}
      />
    </div>
  );
}

function RecentWithdrawals({
  viewer,
  items,
  loading,
  error,
  onRefresh,
  onCancelled,
}: {
  viewer: ActiveIdentity | null;
  items: WithdrawalResponse[];
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
  onCancelled: () => void;
}) {
  const locale = useLanguage();
  const t = walletPanel[locale];
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const isRefreshing = loading && items.length > 0;

  const handleCancel = useCallback(async (withdrawalId: string) => {
    if (!window.confirm(t.cancelWithdrawalConfirm)) {
      return;
    }

    setCancellingId(withdrawalId);
    try {
      await api.cancelWithdrawal(withdrawalId, viewer);
      window.alert(t.cancelWithdrawalSuccess);
      onCancelled();
    } catch (err) {
      if (err instanceof ApiError) {
        window.alert(err.message);
      } else {
        window.alert(t.cancelWithdrawalFailed);
      }
    } finally {
      setCancellingId(null);
    }
  }, [onCancelled, t, viewer]);

  return (
    <div className="rounded-2xl border border-glass-border bg-glass-bg p-5 backdrop-blur-xl">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-text-primary">{t.recentWithdrawals}</h3>
          <p className="text-xs text-text-secondary">{t.recentWithdrawalsHint}</p>
        </div>
        <button
          onClick={onRefresh}
          disabled={isRefreshing}
          className="inline-flex items-center gap-1.5 rounded-lg border border-glass-border px-3 py-1 text-[11px] text-text-secondary transition-colors hover:text-text-primary disabled:opacity-60"
        >
          {isRefreshing ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
          {isRefreshing ? t.refreshing : t.refresh}
        </button>
      </div>

      {loading && items.length === 0 ? (
        <div className="text-sm text-text-secondary">{t.loadingWithdrawals}</div>
      ) : error && items.length === 0 ? (
        <div className="rounded-xl border border-red-400/30 bg-red-400/10 p-3 text-sm text-red-300">
          {error}
        </div>
      ) : items.length === 0 ? (
        <div className="rounded-xl border border-dashed border-glass-border bg-deep-black-light p-4 text-sm text-text-secondary">
          {t.noWithdrawals}
        </div>
      ) : (
        <div className="space-y-3">
          {items.map((item) => {
            const status = getWithdrawalStatusMeta(item.status, t);
            return (
              <div
                key={item.withdrawal_id}
                className="rounded-xl border border-glass-border bg-deep-black-light p-4"
              >
                <div className="mb-2 flex items-start justify-between gap-3">
                  <div>
                    <div className="font-mono text-sm font-semibold text-text-primary">
                      {formatCoinAmount(item.amount_minor)} COIN
                    </div>
                    <div className="mt-1 text-[11px] text-text-secondary">
                      {new Date(item.created_at).toLocaleString()}
                    </div>
                  </div>
                  <span className={`rounded-full px-2.5 py-1 text-[11px] font-medium ${status.className}`}>
                    {status.label}
                  </span>
                </div>

                <div className="flex flex-wrap gap-2 text-[11px] text-text-secondary">
                  <span className="rounded bg-black/20 px-2 py-1">
                    {item.destination_type || "manual_review"}
                  </span>
                  <span className="rounded bg-black/20 px-2 py-1">
                    #{item.withdrawal_id}
                  </span>
                </div>

                {item.status === "pending" ? (
                  <div className="mt-3 flex justify-end">
                    <button
                      type="button"
                      onClick={() => handleCancel(item.withdrawal_id)}
                      disabled={cancellingId === item.withdrawal_id}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-red-400/30 px-3 py-1.5 text-[11px] text-red-300 transition-colors hover:bg-red-400/10 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {cancellingId === item.withdrawal_id ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                      {cancellingId === item.withdrawal_id ? t.cancelling : t.cancelWithdrawal}
                    </button>
                  </div>
                ) : null}
                {item.review_note ? (
                  <div className="mt-3 rounded-lg border border-glass-border bg-black/20 p-3 text-xs text-text-secondary">
                    {item.review_note}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function getWithdrawalStatusMeta(status: string, t: (typeof walletPanel)["en"]) {
  switch (status) {
    case "pending":
      return {
        label: t.pendingReview,
        className: "bg-amber-500/15 text-amber-300",
      };
    case "approved":
    case "processing":
      return {
        label: t.approved,
        className: "bg-sky-500/15 text-sky-300",
      };
    case "completed":
      return {
        label: t.completed,
        className: "bg-emerald-500/15 text-emerald-300",
      };
    case "rejected":
      return {
        label: t.rejected,
        className: "bg-red-500/15 text-red-300",
      };
    case "cancelled":
      return {
        label: t.cancelled,
        className: "bg-white/10 text-text-secondary",
      };
    default:
      return {
        label: status,
        className: "bg-white/10 text-text-secondary",
      };
  }
}
