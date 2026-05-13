"use client";

/**
 * [INPUT]: 依赖 wallet store 的 per-viewer slice 获取指定 bot 的余额/账本/提现申请；依赖三个 Dialog 完成充值/转账/提现
 * [OUTPUT]: BotWalletTab — BotDetailDrawer「钱包」tab 内容；余额卡 + CTA + ledger + 提现申请
 * [POS]: 抽屉中专属某只自有 bot 的钱包视图，与总览页解耦但共享 store
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

import { useCallback, useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { Eye, EyeOff, Loader2 } from "lucide-react";
import { useLanguage } from "@/lib/i18n";
import { walletPanel } from "@/lib/i18n/translations/dashboard";
import { common } from "@/lib/i18n/translations/common";
import { api, ApiError, type ActiveIdentity } from "@/lib/api";
import { useDashboardWalletStore } from "@/store/useDashboardWalletStore";
import { useDashboardUIStore } from "@/store/useDashboardUIStore";
import TransferDialog from "./TransferDialog";
import TopupDialog from "./TopupDialog";
import WithdrawDialog from "./WithdrawDialog";

function formatCoinAmount(minorStr: string | null | undefined): string {
  if (!minorStr) return "0.00";
  const minor = parseInt(minorStr, 10);
  if (isNaN(minor)) return "0.00";
  return (minor / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function showAmount(minorStr: string | null | undefined, hidden: boolean): string {
  return hidden ? "••••••" : formatCoinAmount(minorStr);
}

function txTypeLabel(
  txType: string | null | undefined,
  labels: { topup: string; transfer: string; withdrawal: string; subscription: string; other: string },
): string {
  switch (txType) {
    case "topup": return labels.topup;
    case "transfer": return labels.transfer;
    case "withdrawal": return labels.withdrawal;
    case "subscription": return labels.subscription;
    default: return labels.other;
  }
}

export default function BotWalletTab({
  agentId,
  displayName: _displayName,
}: {
  agentId: string;
  displayName: string;
}) {
  const locale = useLanguage();
  const t = walletPanel[locale];
  const tc = common[locale];
  const viewer: ActiveIdentity = { type: "agent", id: agentId };
  const { walletAmountsHidden, toggleWalletAmountsHidden } = useDashboardUIStore(
    useShallow((s) => ({
      walletAmountsHidden: s.walletAmountsHidden,
      toggleWalletAmountsHidden: s.toggleWalletAmountsHidden,
    })),
  );

  const {
    wallet,
    walletError,
    walletLedger,
    walletLedgerHasMore,
    walletLoading,
    walletLedgerError,
    withdrawalRequests,
    withdrawalRequestsLoading,
    withdrawalRequestsError,
    withdrawalRequestsLoaded,
    setWalletViewer,
    loadWallet,
    loadWalletLedger,
    loadWithdrawalRequests,
  } = useDashboardWalletStore(
    useShallow((s) => ({
      wallet: s.wallet,
      walletError: s.walletError,
      walletLedger: s.walletLedger,
      walletLedgerHasMore: s.walletLedgerHasMore,
      walletLoading: s.walletLoading,
      walletLedgerError: s.walletLedgerError,
      withdrawalRequests: s.withdrawalRequests,
      withdrawalRequestsLoading: s.withdrawalRequestsLoading,
      withdrawalRequestsError: s.withdrawalRequestsError,
      withdrawalRequestsLoaded: s.withdrawalRequestsLoaded,
      setWalletViewer: s.setWalletViewer,
      loadWallet: s.loadWallet,
      loadWalletLedger: s.loadWalletLedger,
      loadWithdrawalRequests: s.loadWithdrawalRequests,
    })),
  );

  const [activeDialog, setActiveDialog] = useState<"transfer" | "topup" | "withdraw" | null>(null);

  // Switch the per-viewer slice to this bot on mount, then trigger loads.
  useEffect(() => {
    setWalletViewer(viewer);
    void loadWallet();
    void loadWalletLedger();
    void loadWithdrawalRequests();
    // We intentionally restart the slice each time the agent id changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId]);

  const handleDialogSuccess = useCallback(() => {
    setActiveDialog(null);
    void loadWallet();
    void loadWalletLedger();
    void loadWithdrawalRequests();
  }, [loadWallet, loadWalletLedger, loadWithdrawalRequests]);

  if (!wallet) {
    return (
      <div className="flex flex-col items-center justify-center py-10 gap-3">
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

  const assetCode = wallet.asset_code;

  return (
    <div className="space-y-4">
      {/* Balance card */}
      <section className="rounded-2xl border border-glass-border bg-glass-bg/30 p-4">
        <div className="mb-1 flex items-center justify-between">
          <span className="text-[10px] font-medium uppercase tracking-wider text-text-secondary">
            {t.totalBalance}
          </span>
          <button
            type="button"
            onClick={toggleWalletAmountsHidden}
            title={walletAmountsHidden ? "显示金额" : "隐藏金额"}
            aria-label={walletAmountsHidden ? "显示金额" : "隐藏金额"}
            className="inline-flex h-6 w-6 items-center justify-center rounded text-text-secondary/70 transition-colors hover:bg-glass-bg hover:text-text-primary"
          >
            {walletAmountsHidden ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
          </button>
        </div>
        <div className="mb-3 flex items-baseline gap-2">
          <span className="font-mono text-2xl font-bold text-text-primary">
            {showAmount(wallet.total_balance_minor, walletAmountsHidden)}
          </span>
          <span className="text-xs font-medium text-text-secondary">{assetCode}</span>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="rounded-lg border border-glass-border bg-deep-black-light p-2.5">
            <div className="text-[10px] uppercase tracking-wider text-text-secondary">{t.available}</div>
            <div className="font-mono text-sm font-semibold text-neon-green">
              {showAmount(wallet.available_balance_minor, walletAmountsHidden)}
            </div>
          </div>
          <div className="rounded-lg border border-glass-border bg-deep-black-light p-2.5">
            <div className="text-[10px] uppercase tracking-wider text-text-secondary">{t.locked}</div>
            <div className="font-mono text-sm font-semibold text-text-secondary">
              {showAmount(wallet.locked_balance_minor, walletAmountsHidden)}
            </div>
          </div>
        </div>

        <div className="mt-4 grid grid-cols-3 gap-2">
          <button
            onClick={() => setActiveDialog("topup")}
            className="rounded-lg border border-glass-border bg-glass-bg px-2 py-2 text-xs font-medium text-neon-green transition-colors hover:bg-neon-green/10"
          >
            {t.recharge}
          </button>
          <button
            onClick={() => setActiveDialog("transfer")}
            className="rounded-lg border border-glass-border bg-glass-bg px-2 py-2 text-xs font-medium text-neon-cyan transition-colors hover:bg-neon-cyan/10"
          >
            {t.transfer}
          </button>
          <button
            onClick={() => setActiveDialog("withdraw")}
            className="rounded-lg border border-glass-border bg-glass-bg px-2 py-2 text-xs font-medium text-neon-purple transition-colors hover:bg-neon-purple/10"
          >
            {t.withdraw}
          </button>
        </div>
      </section>

      {/* Ledger */}
      <section className="rounded-2xl border border-glass-border bg-glass-bg/30 p-4">
        <div className="mb-3">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-text-secondary/80">{t.ledger}</h3>
        </div>
        {walletLedger.length === 0 && !walletLoading ? (
          <div className="rounded-lg border border-dashed border-glass-border bg-deep-black-light p-3 text-xs text-text-secondary">
            {t.noTransactions}
          </div>
        ) : (
          <div className="overflow-hidden rounded-lg border border-glass-border bg-deep-black-light">
            {walletLedger.map((entry) => {
              const isCredit = entry.direction === "credit";
              return (
                <div
                  key={entry.entry_id}
                  className="flex items-center justify-between gap-3 border-b border-glass-border/40 px-3 py-2.5 last:border-b-0"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className={`font-mono text-xs font-semibold ${isCredit ? "text-neon-green" : "text-text-primary"}`}>
                        {walletAmountsHidden ? "••••••" : `${isCredit ? "+" : "-"}${formatCoinAmount(entry.amount_minor)}`}
                      </span>
                      <span className="rounded bg-glass-bg px-1.5 py-0.5 text-[9px] text-text-secondary">
                        {txTypeLabel(entry.tx_type, {
                          topup: t.txTopup,
                          transfer: t.txTransfer,
                          withdrawal: t.txWithdrawal,
                          subscription: t.txSubscription,
                          other: t.txOther,
                        })}
                      </span>
                    </div>
                    <div className="mt-0.5 truncate text-[10px] text-text-secondary/70">
                      {new Date(entry.created_at).toLocaleString()}
                    </div>
                  </div>
                  <div className="font-mono text-[10px] text-text-secondary/60">{assetCode}</div>
                </div>
              );
            })}
          </div>
        )}
        {walletLedgerError && walletLedger.length === 0 ? (
          <div className="mt-2 text-xs text-red-400">{walletLedgerError}</div>
        ) : null}
        {walletLedgerHasMore ? (
          <div className="mt-3 flex justify-center">
            <button
              onClick={() => void loadWalletLedger(true)}
              disabled={walletLoading}
              className="inline-flex items-center gap-1.5 rounded-lg border border-glass-border px-3 py-1 text-[10px] text-text-secondary hover:text-text-primary disabled:opacity-60"
            >
              {walletLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
              {walletLoading ? t.loadingMore : t.loadMore}
            </button>
          </div>
        ) : null}
      </section>

      {/* Withdrawals for this bot */}
      <BotWithdrawals
        viewer={viewer}
        items={withdrawalRequests}
        loading={withdrawalRequestsLoading}
        error={withdrawalRequestsError}
        loaded={withdrawalRequestsLoaded}
        hidden={walletAmountsHidden}
        onRefresh={() => void loadWithdrawalRequests()}
        onCancelled={handleDialogSuccess}
      />

      {activeDialog === "transfer" && (
        <TransferDialog viewer={viewer} onClose={() => setActiveDialog(null)} onSuccess={handleDialogSuccess} />
      )}
      {activeDialog === "topup" && (
        <TopupDialog viewer={viewer} onClose={() => setActiveDialog(null)} onSuccess={handleDialogSuccess} />
      )}
      {activeDialog === "withdraw" && (
        <WithdrawDialog viewer={viewer} onClose={() => setActiveDialog(null)} onSuccess={handleDialogSuccess} />
      )}
    </div>
  );
}

function BotWithdrawals({
  viewer,
  items,
  loading,
  error,
  loaded,
  hidden,
  onRefresh,
  onCancelled,
}: {
  viewer: ActiveIdentity;
  items: Array<{ withdrawal_id: string; amount_minor: string; status: string; destination_type: string | null; review_note: string | null; created_at: string }>;
  loading: boolean;
  error: string | null;
  loaded: boolean;
  hidden: boolean;
  onRefresh: () => void;
  onCancelled: () => void;
}) {
  const locale = useLanguage();
  const t = walletPanel[locale];
  const [cancellingId, setCancellingId] = useState<string | null>(null);

  const handleCancel = useCallback(
    async (withdrawalId: string) => {
      if (!window.confirm(t.cancelWithdrawalConfirm)) return;
      setCancellingId(withdrawalId);
      try {
        await api.cancelWithdrawal(withdrawalId, viewer);
        window.alert(t.cancelWithdrawalSuccess);
        onCancelled();
      } catch (err) {
        if (err instanceof ApiError) window.alert(err.message);
        else window.alert(t.cancelWithdrawalFailed);
      } finally {
        setCancellingId(null);
      }
    },
    [onCancelled, t, viewer],
  );

  return (
    <section className="rounded-2xl border border-glass-border bg-glass-bg/30 p-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-text-secondary/80">{t.recentWithdrawals}</h3>
        <button
          onClick={onRefresh}
          disabled={loading && items.length > 0}
          className="inline-flex items-center gap-1 rounded border border-glass-border px-2 py-0.5 text-[10px] text-text-secondary hover:text-text-primary disabled:opacity-60"
        >
          {loading && items.length > 0 ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
          {loading && items.length > 0 ? t.refreshing : t.refresh}
        </button>
      </div>
      {!loaded && loading ? (
        <div className="text-xs text-text-secondary">{t.loadingWithdrawals}</div>
      ) : error && items.length === 0 ? (
        <div className="rounded-lg border border-red-400/30 bg-red-400/10 p-2 text-xs text-red-300">{error}</div>
      ) : items.length === 0 ? (
        <div className="rounded-lg border border-dashed border-glass-border bg-deep-black-light p-3 text-xs text-text-secondary">
          {t.noWithdrawals}
        </div>
      ) : (
        <div className="space-y-2">
          {items.map((item) => {
            const status = item.status;
            const statusClass =
              status === "pending"
                ? "bg-amber-500/15 text-amber-300"
                : status === "completed"
                  ? "bg-emerald-500/15 text-emerald-300"
                  : status === "rejected"
                    ? "bg-red-500/15 text-red-300"
                    : "bg-white/10 text-text-secondary";
            return (
              <div key={item.withdrawal_id} className="rounded-lg border border-glass-border bg-deep-black-light p-3 text-xs">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="font-mono text-xs font-semibold text-text-primary">
                      {showAmount(item.amount_minor, hidden)}
                    </div>
                    <div className="mt-0.5 text-[10px] text-text-secondary">
                      {new Date(item.created_at).toLocaleString()}
                    </div>
                  </div>
                  <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${statusClass}`}>{status}</span>
                </div>
                {item.status === "pending" ? (
                  <div className="mt-2 flex justify-end">
                    <button
                      onClick={() => handleCancel(item.withdrawal_id)}
                      disabled={cancellingId === item.withdrawal_id}
                      className="inline-flex items-center gap-1 rounded border border-red-400/30 px-2 py-0.5 text-[10px] text-red-300 hover:bg-red-400/10 disabled:opacity-60"
                    >
                      {cancellingId === item.withdrawal_id ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                      {cancellingId === item.withdrawal_id ? t.cancelling : t.cancelWithdrawal}
                    </button>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
