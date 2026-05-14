"use client";

/**
 * [INPUT]: 依赖 wallet store 提供跨账户余额、合并交易记录、提现申请；依赖 session store 提供 ownedAgents / human；依赖 UI store 在点击 bot 余额行时打开 BotDetailDrawer
 * [OUTPUT]: 单一总览页 WalletPanel：总可支配 + 人/Bot 拆分 + CTA + Bot 余额列表 + 合并交易记录(分页) + 提现申请
 * [POS]: dashboard 钱包主面板；旧的「按账户切换 + 概览/账本」结构已废除
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

import { useState, useEffect, useCallback, useMemo } from "react";
import { useLanguage } from "@/lib/i18n";
import { walletPanel } from "@/lib/i18n/translations/dashboard";
import { common } from "@/lib/i18n/translations/common";
import { api, ApiError, type ActiveIdentity } from "@/lib/api";
import type { WithdrawalResponse } from "@/lib/types";
import { useShallow } from "zustand/react/shallow";
import { ChevronRight, Eye, EyeOff, Loader2 } from "lucide-react";
import { useDashboardSessionStore } from "@/store/useDashboardSessionStore";
import {
  useDashboardWalletStore,
  type MergedLedgerEntry,
} from "@/store/useDashboardWalletStore";
import { useDashboardUIStore } from "@/store/useDashboardUIStore";
import BotAvatar from "./BotAvatar";
import TransferDialog from "./TransferDialog";
import TopupDialog from "./TopupDialog";
import WithdrawDialog from "./WithdrawDialog";
import DashboardTabSkeleton from "./DashboardTabSkeleton";

function formatCoinAmount(minorStr: string | null | undefined): string {
  if (!minorStr) return "0.00";
  const minor = parseInt(minorStr, 10);
  if (isNaN(minor)) return "0.00";
  const major = minor / 100;
  return major.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Display helper: replace numeric amount with mask when hidden. */
function showAmount(minorStr: string | null | undefined, hidden: boolean): string {
  return hidden ? "••••••" : formatCoinAmount(minorStr);
}

function sumMinor(values: Array<string | null | undefined>): string {
  let total = 0;
  for (const v of values) {
    if (!v) continue;
    const n = parseInt(v, 10);
    if (!isNaN(n)) total += n;
  }
  return String(total);
}

export default function WalletPanel() {
  const locale = useLanguage();
  const t = walletPanel[locale];
  const tc = common[locale];

  const {
    humanWallet,
    botWallets,
    walletsLoaded,
    walletsLoading,
    walletsError,
    mergedLedger,
    mergedLedgerLoading,
    mergedLedgerHasMore,
    withdrawalRequests,
    withdrawalRequestsLoading,
    withdrawalRequestsError,
    withdrawalRequestsLoaded,
    loadAllWallets,
    loadMergedLedger,
    loadWithdrawalRequests,
  } = useDashboardWalletStore(
    useShallow((s) => ({
      humanWallet: s.humanWallet,
      botWallets: s.botWallets,
      walletsLoaded: s.walletsLoaded,
      walletsLoading: s.walletsLoading,
      walletsError: s.walletsError,
      mergedLedger: s.mergedLedger,
      mergedLedgerLoading: s.mergedLedgerLoading,
      mergedLedgerHasMore: s.mergedLedgerHasMore,
      withdrawalRequests: s.withdrawalRequests,
      withdrawalRequestsLoading: s.withdrawalRequestsLoading,
      withdrawalRequestsError: s.withdrawalRequestsError,
      withdrawalRequestsLoaded: s.withdrawalRequestsLoaded,
      loadAllWallets: s.loadAllWallets,
      loadMergedLedger: s.loadMergedLedger,
      loadWithdrawalRequests: s.loadWithdrawalRequests,
    })),
  );

  const { ownedAgents, human } = useDashboardSessionStore(
    useShallow((s) => ({ ownedAgents: s.ownedAgents, human: s.human })),
  );
  const { openBotDetail, walletAmountsHidden, toggleWalletAmountsHidden } = useDashboardUIStore(
    useShallow((s) => ({
      openBotDetail: s.openBotDetail,
      walletAmountsHidden: s.walletAmountsHidden,
      toggleWalletAmountsHidden: s.toggleWalletAmountsHidden,
    })),
  );

  const [activeDialog, setActiveDialog] = useState<"transfer" | "topup" | "withdraw" | null>(null);
  // Account preselected when a CTA opens. Defaults to "我".
  const [dialogDefaultViewer, setDialogDefaultViewer] = useState<ActiveIdentity | null>(null);

  // Initial bootstrap: wallets + ledger + my withdrawals.
  useEffect(() => {
    if (!walletsLoaded && !walletsLoading) void loadAllWallets();
  }, [walletsLoaded, walletsLoading, loadAllWallets]);

  useEffect(() => {
    if (mergedLedger.length === 0 && !mergedLedgerLoading) void loadMergedLedger();
    // intentionally only on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (
      !withdrawalRequestsLoaded
      && !withdrawalRequestsLoading
      && !withdrawalRequestsError
    ) {
      void loadWithdrawalRequests();
    }
  }, [
    withdrawalRequestsLoaded,
    withdrawalRequestsLoading,
    withdrawalRequestsError,
    loadWithdrawalRequests,
  ]);

  const humanIdentity: ActiveIdentity | null = human?.human_id
    ? { type: "human", id: human.human_id }
    : null;

  const totalMinor = useMemo(() => {
    const values: string[] = [];
    if (humanWallet) values.push(humanWallet.total_balance_minor);
    for (const w of Object.values(botWallets)) {
      if (w) values.push(w.total_balance_minor);
    }
    return sumMinor(values);
  }, [humanWallet, botWallets]);

  const humanShareMinor = humanWallet?.total_balance_minor ?? "0";
  const botShareMinor = useMemo(
    () =>
      sumMinor(
        Object.values(botWallets)
          .filter((w): w is NonNullable<typeof w> => !!w)
          .map((w) => w.total_balance_minor),
      ),
    [botWallets],
  );
  const firstBotWallet = useMemo(
    () => Object.values(botWallets).find((w): w is NonNullable<typeof w> => !!w),
    [botWallets],
  );
  const assetCode = humanWallet?.asset_code ?? firstBotWallet?.asset_code ?? "COIN";

  const handleDialogSuccess = useCallback(() => {
    setActiveDialog(null);
    void loadAllWallets();
    void loadMergedLedger();
    void loadWithdrawalRequests();
  }, [loadAllWallets, loadMergedLedger, loadWithdrawalRequests]);

  const handleOpenDialog = useCallback(
    (kind: "transfer" | "topup" | "withdraw") => {
      setDialogDefaultViewer(humanIdentity);
      setActiveDialog(kind);
    },
    [humanIdentity],
  );

  // Initial bootstrap not yet finished — show skeleton.
  if (!walletsLoaded) {
    if (!walletsError) {
      return <DashboardTabSkeleton variant="wallet" />;
    }
    return (
      <div className="flex flex-1 flex-col items-center justify-center bg-deep-black gap-3">
        <div className="text-sm text-red-400">{walletsError}</div>
        <button
          onClick={() => void loadAllWallets()}
          className="rounded border border-glass-border px-4 py-2 text-xs text-text-secondary hover:text-text-primary"
        >
          {tc.retry}
        </button>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto bg-deep-black">
      <div className="mx-auto max-w-5xl px-6 py-8">
        <div className="mb-6 flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold text-text-primary">{t.wallet}</h1>
            <p className="mt-1 text-sm text-text-secondary/70">{t.pageSubtitle}</p>
          </div>
          <button
            type="button"
            onClick={toggleWalletAmountsHidden}
            title={walletAmountsHidden ? "显示金额" : "隐藏金额"}
            aria-label={walletAmountsHidden ? "显示金额" : "隐藏金额"}
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-glass-border text-text-secondary transition-colors hover:border-neon-cyan/30 hover:text-text-primary"
          >
            {walletAmountsHidden ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </button>
        </div>

        <div className="space-y-6">
          {/* Total disposable card */}
          <div className="rounded-2xl border border-glass-border bg-glass-bg p-6 backdrop-blur-xl">
            <div className="mb-1 text-xs font-medium uppercase tracking-wider text-text-secondary">
              {t.totalDisposable}
            </div>
            <div className="mb-5 flex items-baseline gap-2">
              <span className="font-mono text-4xl font-bold text-text-primary">
                {showAmount(totalMinor, walletAmountsHidden)}
              </span>
              <span className="text-sm font-medium text-text-secondary">{assetCode}</span>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="rounded-xl border border-glass-border bg-deep-black-light p-4">
                <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-text-secondary">
                  {t.humanShare}
                </div>
                <div className="font-mono text-xl font-semibold text-neon-green">
                  {showAmount(humanShareMinor, walletAmountsHidden)}
                </div>
              </div>
              <div className="rounded-xl border border-glass-border bg-deep-black-light p-4">
                <div className="mb-1 flex items-baseline justify-between gap-2">
                  <span className="text-[10px] font-medium uppercase tracking-wider text-text-secondary">
                    {t.botShare}
                  </span>
                  <span className="text-[10px] text-text-secondary/70">
                    {t.botShareCount.replace("{count}", String(ownedAgents.length))}
                  </span>
                </div>
                <div className="font-mono text-xl font-semibold text-neon-cyan">
                  {showAmount(botShareMinor, walletAmountsHidden)}
                </div>
              </div>
            </div>

            {/* Quick Actions */}
            <div className="mt-5 grid grid-cols-3 gap-3">
              <CtaButton
                color="green"
                label={t.recharge}
                onClick={() => handleOpenDialog("topup")}
                icon={
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
                }
              />
              <CtaButton
                color="cyan"
                label={t.transfer}
                onClick={() => handleOpenDialog("transfer")}
                icon={
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M7.5 21L3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5"
                  />
                }
              />
              <CtaButton
                color="purple"
                label={t.withdraw}
                onClick={() => handleOpenDialog("withdraw")}
                icon={
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3"
                  />
                }
              />
            </div>
          </div>

          {/* Bot balances list */}
          <BotBalancesSection
            label={t.botBalances}
            empty={t.noBots}
            ownedAgents={ownedAgents.map((a) => ({ agent_id: a.agent_id, display_name: a.display_name, avatar_url: a.avatar_url ?? null }))}
            botWallets={botWallets}
            assetCode={assetCode}
            hidden={walletAmountsHidden}
            onClickBot={(agentId) => openBotDetail(agentId, "wallet")}
          />

          {/* Merged ledger */}
          <MergedLedgerSection
            entries={mergedLedger}
            loading={mergedLedgerLoading}
            hasMore={mergedLedgerHasMore}
            onLoadMore={() => loadMergedLedger(true)}
            assetCode={assetCode}
            hidden={walletAmountsHidden}
            title={t.recentTransactions}
            hint={t.recentTransactionsHint}
            loadMoreLabel={t.loadMore}
            loadingMoreLabel={t.loadingMore}
            emptyLabel={t.noTransactions}
            txTypeLabels={{
              topup: t.txTopup,
              transfer: t.txTransfer,
              withdrawal: t.txWithdrawal,
              subscription: t.txSubscription,
              other: t.txOther,
            }}
          />

          {/* My (human) withdrawal requests */}
          <RecentWithdrawals
            viewer={humanIdentity}
            items={withdrawalRequests}
            loading={withdrawalRequestsLoading}
            error={withdrawalRequestsError}
            hidden={walletAmountsHidden}
            onRefresh={loadWithdrawalRequests}
            onCancelled={handleDialogSuccess}
          />
        </div>
      </div>

      {activeDialog === "transfer" && (
        <TransferDialog
          viewer={dialogDefaultViewer}
          onClose={() => setActiveDialog(null)}
          onSuccess={handleDialogSuccess}
        />
      )}
      {activeDialog === "topup" && (
        <TopupDialog
          viewer={dialogDefaultViewer}
          onClose={() => setActiveDialog(null)}
          onSuccess={handleDialogSuccess}
        />
      )}
      {activeDialog === "withdraw" && (
        <WithdrawDialog
          viewer={dialogDefaultViewer}
          onClose={() => setActiveDialog(null)}
          onSuccess={handleDialogSuccess}
        />
      )}
    </div>
  );
}

function CtaButton({
  color,
  label,
  onClick,
  icon,
}: {
  color: "green" | "cyan" | "purple";
  label: string;
  onClick: () => void;
  icon: React.ReactNode;
}) {
  const palette = {
    green: { hoverBorder: "hover:border-neon-green/30", hoverBg: "hover:bg-neon-green/5", iconColor: "text-neon-green" },
    cyan: { hoverBorder: "hover:border-neon-cyan/30", hoverBg: "hover:bg-neon-cyan/5", iconColor: "text-neon-cyan" },
    purple: { hoverBorder: "hover:border-neon-purple/30", hoverBg: "hover:bg-neon-purple/5", iconColor: "text-neon-purple" },
  }[color];
  return (
    <button
      onClick={onClick}
      className={`flex flex-col items-center gap-2 rounded-xl border border-glass-border bg-glass-bg p-4 transition-all ${palette.hoverBorder} ${palette.hoverBg}`}
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className={`h-6 w-6 ${palette.iconColor}`}>
        {icon}
      </svg>
      <span className="text-xs font-medium text-text-primary">{label}</span>
    </button>
  );
}

function BotBalancesSection({
  label,
  empty,
  ownedAgents,
  botWallets,
  assetCode,
  hidden,
  onClickBot,
}: {
  label: string;
  empty: string;
  ownedAgents: Array<{ agent_id: string; display_name: string; avatar_url: string | null }>;
  botWallets: Record<string, { total_balance_minor: string; available_balance_minor: string } | null>;
  assetCode: string;
  hidden: boolean;
  onClickBot: (agentId: string) => void;
}) {
  return (
    <div className="rounded-2xl border border-glass-border bg-glass-bg p-5 backdrop-blur-xl">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-text-primary">{label}</h3>
      </div>
      {ownedAgents.length === 0 ? (
        <div className="rounded-xl border border-dashed border-glass-border bg-deep-black-light p-4 text-sm text-text-secondary">
          {empty}
        </div>
      ) : (
        <div className="space-y-2">
          {ownedAgents.map((agent) => {
            const w = botWallets[agent.agent_id];
            return (
              <button
                key={agent.agent_id}
                onClick={() => onClickBot(agent.agent_id)}
                className="flex w-full items-center gap-3 rounded-xl border border-glass-border bg-deep-black-light px-3.5 py-3 text-left transition-colors hover:border-neon-cyan/30 hover:bg-neon-cyan/5"
              >
                <BotAvatar agentId={agent.agent_id} alt={agent.display_name} avatarUrl={agent.avatar_url} size={36} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-text-primary">{agent.display_name}</div>
                  <div className="truncate font-mono text-[10px] text-text-secondary/60">{agent.agent_id}</div>
                </div>
                <div className="text-right">
                  <div className="font-mono text-base font-semibold text-text-primary">
                    {showAmount(w?.total_balance_minor, hidden)}
                  </div>
                  <div className="text-[10px] text-text-secondary/60">{assetCode}</div>
                </div>
                <ChevronRight className="h-4 w-4 shrink-0 text-text-secondary/40" />
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function txTypeLabel(txType: string | null | undefined, labels: { topup: string; transfer: string; withdrawal: string; subscription: string; other: string }): string {
  switch (txType) {
    case "topup": return labels.topup;
    case "transfer": return labels.transfer;
    case "withdrawal": return labels.withdrawal;
    case "subscription": return labels.subscription;
    default: return labels.other;
  }
}

function MergedLedgerSection({
  entries,
  loading,
  hasMore,
  onLoadMore,
  assetCode,
  hidden,
  title,
  hint,
  loadMoreLabel,
  loadingMoreLabel,
  emptyLabel,
  txTypeLabels,
}: {
  entries: MergedLedgerEntry[];
  loading: boolean;
  hasMore: boolean;
  onLoadMore: () => void;
  assetCode: string;
  hidden: boolean;
  title: string;
  hint: string;
  loadMoreLabel: string;
  loadingMoreLabel: string;
  emptyLabel: string;
  txTypeLabels: { topup: string; transfer: string; withdrawal: string; subscription: string; other: string };
}) {
  return (
    <div className="rounded-2xl border border-glass-border bg-glass-bg p-5 backdrop-blur-xl">
      <div className="mb-3">
        <h3 className="text-sm font-semibold text-text-primary">{title}</h3>
        <p className="text-xs text-text-secondary/70">{hint}</p>
      </div>

      {entries.length === 0 && !loading ? (
        <div className="rounded-xl border border-dashed border-glass-border bg-deep-black-light p-4 text-sm text-text-secondary">
          {emptyLabel}
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-glass-border bg-deep-black-light">
          {entries.map((entry) => {
            const isCredit = entry.direction === "credit";
            return (
              <div
                key={entry.entry_id}
                className="flex items-center justify-between gap-4 border-b border-glass-border/40 px-4 py-3 last:border-b-0"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className={`font-mono text-sm font-semibold ${isCredit ? "text-neon-green" : "text-text-primary"}`}>
                      {hidden ? "••••••" : `${isCredit ? "+" : "-"}${formatCoinAmount(entry.amount_minor)}`}
                    </span>
                    <span className="rounded bg-glass-bg px-2 py-0.5 text-[10px] text-text-secondary">
                      {txTypeLabel(entry.tx_type, txTypeLabels)}
                    </span>
                  </div>
                  <div className="mt-1 truncate text-[11px] text-text-secondary/70">
                    {new Date(entry.created_at).toLocaleString()}
                  </div>
                </div>
                <div className="text-right text-[11px] text-text-secondary">
                  <div className="truncate">{entry._account.display_name}</div>
                  <div className="font-mono text-[10px] text-text-secondary/50">{assetCode}</div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {hasMore ? (
        <div className="mt-3 flex justify-center">
          <button
            onClick={onLoadMore}
            disabled={loading}
            className="inline-flex items-center gap-1.5 rounded-lg border border-glass-border px-4 py-1.5 text-[11px] text-text-secondary transition-colors hover:text-text-primary disabled:opacity-60"
          >
            {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
            {loading ? loadingMoreLabel : loadMoreLabel}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function RecentWithdrawals({
  viewer,
  items,
  loading,
  error,
  hidden,
  onRefresh,
  onCancelled,
}: {
  viewer: ActiveIdentity | null;
  items: WithdrawalResponse[];
  loading: boolean;
  error: string | null;
  hidden: boolean;
  onRefresh: () => void;
  onCancelled: () => void;
}) {
  const locale = useLanguage();
  const t = walletPanel[locale];
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const isRefreshing = loading && items.length > 0;

  const handleCancel = useCallback(
    async (withdrawalId: string) => {
      if (!window.confirm(t.cancelWithdrawalConfirm)) return;
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
    },
    [onCancelled, t, viewer],
  );

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
                      {showAmount(item.amount_minor, hidden)} COIN
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
                  <span className="rounded bg-black/20 px-2 py-1">#{item.withdrawal_id}</span>
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
      return { label: t.pendingReview, className: "bg-amber-500/15 text-amber-300" };
    case "approved":
    case "processing":
      return { label: t.approved, className: "bg-sky-500/15 text-sky-300" };
    case "completed":
      return { label: t.completed, className: "bg-emerald-500/15 text-emerald-300" };
    case "rejected":
      return { label: t.rejected, className: "bg-red-500/15 text-red-300" };
    case "cancelled":
      return { label: t.cancelled, className: "bg-white/10 text-text-secondary" };
    default:
      return { label: status, className: "bg-white/10 text-text-secondary" };
  }
}
