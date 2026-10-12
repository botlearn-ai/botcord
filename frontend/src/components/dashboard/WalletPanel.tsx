"use client";

/**
 * [INPUT]: 依赖 wallet store 提供跨账户余额、合并交易记录、提现申请；依赖 session store 提供 ownedAgents / human；依赖 UI store 在点击 bot 余额行时打开 BotDetailDrawer
 * [OUTPUT]: 单一总览页 WalletPanel：总可支配 + 人/Bot 拆分 + CTA + Bot 余额列表 + 合并交易记录(分页) + 提现申请
 * [POS]: dashboard 钱包主面板；旧的「按账户切换 + 概览/账本」结构已废除
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

import EmptyState from "@/components/ui/EmptyState";
import Badge from "@/components/ui/Badge";
import Alert from "@/components/ui/Alert";
import IconButton from "@/components/ui/IconButton";
import Button from "@/components/ui/Button";
import Card from "@/components/ui/Card";
import { useState, useEffect, useCallback, useMemo, memo } from "react";
import { useLanguage } from "@/lib/i18n";
import { walletPanel } from "@/lib/i18n/translations/dashboard";
import { common } from "@/lib/i18n/translations/common";
import { api, ApiError, type ActiveIdentity } from "@/lib/api";
import type { WithdrawalResponse } from "@/lib/types";
import { useShallow } from "zustand/react/shallow";
import { ChevronRight, Eye, EyeOff, Loader2 } from "lucide-react";
import { BotCordLoader, MobileBotCordLoading } from "@/components/ui/BotCordLoader";
import { useDashboardSessionStore } from "@/store/useDashboardSessionStore";
import {
  useDashboardWalletStore,
  type MergedLedgerEntry,
} from "@/store/useDashboardWalletStore";
import { useDashboardUIStore } from "@/store/useDashboardUIStore";
import { useConfirm } from "@/store/useConfirmStore";
import BotAvatar from "./BotAvatar";
import TransferDialog from "./TransferDialog";
import TopupDialog from "./TopupDialog";
import WithdrawDialog from "./WithdrawDialog";

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

export default memo(WalletPanel);

function WalletPanel() {
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
    mergedLedgerLoaded,
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
      mergedLedgerLoaded: s.mergedLedgerLoaded,
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
    if (!mergedLedgerLoaded && !mergedLedgerLoading) void loadMergedLedger();
  }, [mergedLedgerLoaded, mergedLedgerLoading, loadMergedLedger]);

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

  return (
    <div className="dashboard-main h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl px-6 py-8">
        <div className="mb-6 flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold text-text-primary">{t.wallet}</h1>
            <p className="mt-1 text-sm text-text-secondary">{t.pageSubtitle}</p>
          </div>
          <IconButton size="sm" label={walletAmountsHidden ? "显示金额" : "隐藏金额"}
            type="button"
            onClick={toggleWalletAmountsHidden}
            title={walletAmountsHidden ? "显示金额" : "隐藏金额"}
            aria-label={walletAmountsHidden ? "显示金额" : "隐藏金额"}
            className="inline-flex shrink-0 items-center justify-center"
          >
            {walletAmountsHidden ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </IconButton>
        </div>

        <div className="space-y-6">
          {/* Keep independent sections usable while all-account totals settle. */}
          {walletsError && (
            <Alert tone="danger" role="alert" className="flex items-center gap-3">
              {walletsError}
              <Button variant="secondary" size="sm" onClick={() => void loadAllWallets()} disabled={walletsLoading} >{tc.retry}</Button>
            </Alert>
          )}
          {!walletsLoaded ? (
            <Card padding="md" className="flex min-h-[22rem] items-center justify-center">
              <MobileBotCordLoading label={tc.loading} />
            </Card>
          ) : (
            <Card padding="md" className="">
              <div className="mb-1 text-xs font-medium uppercase tracking-wider text-text-secondary">
                {t.totalDisposable}
              </div>
              <div className="mb-5 flex items-baseline gap-2">
                <span className="font-mono text-4xl font-semibold text-text-primary">
                  {showAmount(totalMinor, walletAmountsHidden)}
                </span>
                <span className="text-sm font-medium text-text-secondary">{assetCode}</span>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="liquid-tool-surface rounded-xl border border-glass-border p-4">
                  <div className="mb-1 text-xs font-medium uppercase tracking-wider text-text-secondary">
                    {t.humanShare}
                  </div>
                  <div className="font-mono text-xl font-semibold text-success">
                    {showAmount(humanShareMinor, walletAmountsHidden)}
                  </div>
                </div>
                <div className="liquid-tool-surface rounded-xl border border-glass-border p-4">
                  <div className="mb-1 flex items-baseline justify-between gap-2">
                    <span className="text-xs font-medium uppercase tracking-wider text-text-secondary">
                      {t.botShare}
                    </span>
                    <span className="text-xs text-text-secondary">
                      {t.botShareCount.replace("{count}", String(ownedAgents.length))}
                    </span>
                  </div>
                  <div className="font-mono text-xl font-semibold text-accent-text">
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
            </Card>

          )}

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
            loading={mergedLedgerLoading || !mergedLedgerLoaded}
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
            loading={withdrawalRequestsLoading || !withdrawalRequestsLoaded}
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
    green: { hoverBorder: "hover:border-neon-green/30", hoverBg: "hover:bg-success-soft", iconColor: "text-success" },
    cyan: { hoverBorder: "hover:border-neon-cyan/30", hoverBg: "hover:bg-accent-soft", iconColor: "text-accent-text" },
    purple: { hoverBorder: "hover:border-neon-cyan/30", hoverBg: "hover:bg-accent-soft", iconColor: "text-accent-text" },
  }[color];
  return (
    <Card as="button" variant="interactive" padding="md"
      onClick={onClick}
      className={`flex flex-col items-center gap-2  `}
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className={`h-6 w-6 ${palette.iconColor}`}>
        {icon}
      </svg>
      <span className="text-xs font-medium text-text-primary">{label}</span>
    </Card>
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
    <Card padding="md" className="">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-text-primary">{label}</h3>
      </div>
      {ownedAgents.length === 0 ? (
        <EmptyState compact bordered title={<>{empty}</>} />
      ) : (
        <div className="space-y-2">
          {ownedAgents.map((agent) => {
            const w = botWallets[agent.agent_id];
            return (
              <Button variant="row"
                key={agent.agent_id}
                onClick={() => onClickBot(agent.agent_id)}
                className="flex w-full items-center gap-3"
              >
                <BotAvatar agentId={agent.agent_id} alt={agent.display_name} avatarUrl={agent.avatar_url} size={36} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-text-primary">{agent.display_name}</div>
                  <div className="truncate font-mono text-xs text-text-secondary">{agent.agent_id}</div>
                </div>
                <div className="text-right">
                  <div className="font-mono text-base font-semibold text-text-primary">
                    {w ? showAmount(w.total_balance_minor, hidden) : "—"}
                  </div>
                  <div className="text-xs text-text-secondary">{assetCode}</div>
                </div>
                <ChevronRight className="h-4 w-4 shrink-0 text-text-secondary" />
              </Button>
            );
          })}
        </div>
      )}
    </Card>
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
    <Card padding="md" className="">
      <div className="mb-3">
        <h3 className="text-sm font-semibold text-text-primary">{title}</h3>
        <p className="text-xs text-text-secondary">{hint}</p>
      </div>

      {entries.length === 0 && loading ? (
        <MobileBotCordLoading label={loadingMoreLabel} />
      ) : entries.length === 0 ? (
        <EmptyState compact bordered title={<>{emptyLabel}</>} />
      ) : (
        <div className="liquid-tool-surface overflow-hidden rounded-xl border border-glass-border">
          {entries.map((entry) => {
            const isCredit = entry.direction === "credit";
            return (
              <Card padding="md"
                key={entry.entry_id}
                className="flex items-center justify-between gap-4"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className={`font-mono text-sm font-semibold ${isCredit ? "text-success" : "text-text-primary"}`}>
                      {hidden ? "••••••" : `${isCredit ? "+" : "-"}${formatCoinAmount(entry.amount_minor)}`}
                    </span>
                    <Badge tone="neutral" >
                      {txTypeLabel(entry.tx_type, txTypeLabels)}
                    </Badge>
                  </div>
                  <div className="mt-1 truncate text-xs text-text-secondary">
                    {new Date(entry.created_at).toLocaleString()}
                  </div>
                </div>
                <div className="text-right text-xs text-text-secondary">
                  <div className="truncate">{entry._account.display_name}</div>
                  <div className="font-mono text-xs text-text-secondary">{assetCode}</div>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {hasMore ? (
        <div className="mt-3 flex justify-center">
          <Button variant="secondary" size="sm"
            onClick={onLoadMore}
            disabled={loading}
            className="inline-flex min-w-[5.5rem] items-center justify-center gap-1.5 disabled:opacity-60"
          >
            {loading ? (
              <>
                <BotCordLoader
                  label={loadingMoreLabel}
                  size="xs"
                  showLabel={false}
                  className="md:hidden"
                />
                <Loader2 className="hidden h-3 w-3 animate-spin md:inline" />
                <span className="hidden md:inline">{loadingMoreLabel}</span>
              </>
            ) : (
              loadMoreLabel
            )}
          </Button>
        </div>
      ) : null}
    </Card>
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
  const confirm = useConfirm();
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const isRefreshing = loading && items.length > 0;

  const handleCancel = useCallback(
    async (withdrawalId: string) => {
      if (!(await confirm({ title: t.cancelWithdrawalConfirm, tone: "danger" }))) return;
      setCancellingId(withdrawalId);
      try {
        await api.cancelWithdrawal(withdrawalId, viewer);
        await confirm({ title: t.cancelWithdrawalSuccess, alert: true });
        onCancelled();
      } catch (err) {
        if (err instanceof ApiError) {
          await confirm({ title: err.message, alert: true });
        } else {
          await confirm({ title: t.cancelWithdrawalFailed, alert: true });
        }
      } finally {
        setCancellingId(null);
      }
    },
    [confirm, onCancelled, t, viewer],
  );

  return (
    <Card padding="md" className="">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-text-primary">{t.recentWithdrawals}</h3>
          <p className="text-xs text-text-secondary">{t.recentWithdrawalsHint}</p>
        </div>
        <Button variant="secondary" size="sm"
          onClick={onRefresh}
          disabled={isRefreshing}
          className="inline-flex items-center gap-1.5 disabled:opacity-60"
        >
          {isRefreshing ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
          {isRefreshing ? t.refreshing : t.refresh}
        </Button>
      </div>

      {loading && items.length === 0 ? (
        <MobileBotCordLoading
          label={t.loadingWithdrawals}
          className="justify-start"
          textClassName="text-sm text-text-secondary"
        />
      ) : error && items.length === 0 ? (
        <Alert tone="danger" className="">
          {error}
        </Alert>
      ) : items.length === 0 ? (
        <EmptyState compact bordered title={<>{t.noWithdrawals}</>} />
      ) : (
        <div className="space-y-3">
          {items.map((item) => {
            const status = getWithdrawalStatusMeta(item.status, t);
            return (
              <div
                key={item.withdrawal_id}
                className="liquid-tool-surface rounded-xl border border-glass-border p-4"
              >
                <div className="mb-2 flex items-start justify-between gap-3">
                  <div>
                    <div className="font-mono text-sm font-semibold text-text-primary">
                      {showAmount(item.amount_minor, hidden)} COIN
                    </div>
                    <div className="mt-1 text-xs text-text-secondary">
                      {new Date(item.created_at).toLocaleString()}
                    </div>
                  </div>
                  <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${status.className}`}>
                    {status.label}
                  </span>
                </div>

                <div className="flex flex-wrap gap-2 text-xs text-text-secondary">
                  <span className="rounded bg-glass-bg/70 px-2 py-1">
                    {item.destination_type || "manual_review"}
                  </span>
                  <span className="rounded bg-glass-bg/70 px-2 py-1">#{item.withdrawal_id}</span>
                </div>

                {item.status === "pending" ? (
                  <div className="mt-3 flex justify-end">
                    <Button variant="danger" size="sm"
                      type="button"
                      onClick={() => handleCancel(item.withdrawal_id)}
                      disabled={cancellingId === item.withdrawal_id}
                      className="inline-flex items-center gap-1.5 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {cancellingId === item.withdrawal_id ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                      {cancellingId === item.withdrawal_id ? t.cancelling : t.cancelWithdrawal}
                    </Button>
                  </div>
                ) : null}
                {item.review_note ? (
                  <div className="liquid-tool-surface mt-3 rounded-lg border border-glass-border p-3 text-xs text-text-secondary">
                    {item.review_note}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

function getWithdrawalStatusMeta(status: string, t: (typeof walletPanel)["en"]) {
  switch (status) {
    case "pending":
      return { label: t.pendingReview, className: "bg-warning-soft text-warning" };
    case "approved":
    case "processing":
      return { label: t.approved, className: "bg-sky-500/15 text-accent-text" };
    case "completed":
      return { label: t.completed, className: "bg-emerald-500/15 text-success" };
    case "rejected":
      return { label: t.rejected, className: "bg-danger-soft text-danger" };
    case "cancelled":
      return { label: t.cancelled, className: "bg-glass-bg/70 text-text-secondary" };
    default:
      return { label: status, className: "bg-glass-bg/70 text-text-secondary" };
  }
}
