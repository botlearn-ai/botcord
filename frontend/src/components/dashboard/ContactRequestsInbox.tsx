"use client";

/**
 * [INPUT]: 依赖 contact store 的 received/sent requests、humansApi pending approvals 与 respond/resolve 动作；本地状态控制 received/sent sub-tab 与 Bot 分组折叠
 * [OUTPUT]: ContactRequestsInbox — 联系人申请收件箱，Human 请求置顶、Bot 收到的请求按目标 Bot 折叠分组、Sent tab 展示发出请求
 * [POS]: 联系人申请处理模块的复用组件
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import { ChevronDown, Loader2, Mail, Send } from "lucide-react";
import { useDashboardContactStore } from "@/store/useDashboardContactStore";
import { useDashboardSessionStore } from "@/store/useDashboardSessionStore";
import { useLanguage } from "@/lib/i18n";
import { chatPane } from "@/lib/i18n/translations/dashboard";
import { humansApi } from "@/lib/api";
import type { ContactRequestItem, PendingApproval } from "@/lib/types";
import BotAvatar from "./BotAvatar";

type Tab = "received" | "sent";
type Locale = "en" | "zh";
type BotApprovalAction = { id: string; decision: "approve" | "reject" } | null;

interface Props {
  /** Initial sub-tab. Defaults to "received". */
  initialTab?: Tab;
  /** Hide the sub-tab toggle entirely (e.g. when used in the Messages-inline view we only want received). */
  hideTabs?: boolean;
  /**
   * Optional title to render above the list. ChatPane already shows its own header,
   * so it'll pass undefined; the inline Messages view passes a title.
   */
  title?: ReactNode;
  /** Optional empty-state hint when the active list has 0 items. */
  emptyHint?: ReactNode;
}

interface BotApprovalGroup {
  agentId: string;
  displayName: string;
  approvals: PendingApproval[];
}

export default function ContactRequestsInbox({
  initialTab = "received",
  hideTabs = false,
  title,
  emptyHint,
}: Props) {
  const locale = useLanguage();
  const t = chatPane[locale];

  const {
    contactRequestsReceived,
    contactRequestsSent,
    contactRequestsLoading,
    processingContactRequestId,
    processingContactRequestAction,
    respondContactRequest,
    loadContactRequests,
  } = useDashboardContactStore(
    useShallow((s) => ({
      contactRequestsReceived: s.contactRequestsReceived,
      contactRequestsSent: s.contactRequestsSent,
      contactRequestsLoading: s.contactRequestsLoading,
      processingContactRequestId: s.processingContactRequestId,
      processingContactRequestAction: s.processingContactRequestAction,
      respondContactRequest: s.respondContactRequest,
      loadContactRequests: s.loadContactRequests,
    })),
  );
  const { isAuthed, ownedAgents } = useDashboardSessionStore(
    useShallow((s) => ({
      isAuthed: s.sessionMode === "authed-ready" || s.sessionMode === "authed-no-agent",
      ownedAgents: s.ownedAgents,
    })),
  );

  const [tab, setTab] = useState<Tab>(initialTab);
  const [botApprovals, setBotApprovals] = useState<PendingApproval[]>([]);
  const [botApprovalsLoading, setBotApprovalsLoading] = useState(false);
  const [botApprovalsError, setBotApprovalsError] = useState<string | null>(null);
  const [botApprovalAction, setBotApprovalAction] = useState<BotApprovalAction>(null);
  const [expandedBotGroups, setExpandedBotGroups] = useState<Record<string, boolean>>({});

  const refreshBotApprovals = useCallback(async () => {
    setBotApprovalsLoading(true);
    setBotApprovalsError(null);
    try {
      const res = await humansApi.listPendingApprovals();
      setBotApprovals(
        res.approvals.filter((approval) => (
          approval.kind === "contact_request" && !approval.id.startsWith("cr_")
        )),
      );
    } catch (err: any) {
      setBotApprovals([]);
      setBotApprovalsError(err?.message || (locale === "zh" ? "加载 Bot 请求失败" : "Failed to load bot requests"));
    } finally {
      setBotApprovalsLoading(false);
    }
  }, [locale]);

  useEffect(() => {
    if (isAuthed) void Promise.all([loadContactRequests(), refreshBotApprovals()]);
  }, [isAuthed, loadContactRequests, refreshBotApprovals]);

  const pendingReceived = contactRequestsReceived.filter((r) => r.state === "pending");
  const visibleSent = contactRequestsSent;
  const agentNameById = useMemo(
    () => new Map(ownedAgents.map((agent) => [agent.agent_id, agent.display_name])),
    [ownedAgents],
  );
  const botApprovalGroups = useMemo<BotApprovalGroup[]>(() => {
    const grouped = new Map<string, PendingApproval[]>();
    for (const approval of botApprovals) {
      const list = grouped.get(approval.agent_id) ?? [];
      list.push(approval);
      grouped.set(approval.agent_id, list);
    }
    return Array.from(grouped.entries())
      .map(([agentId, approvals]) => ({
        agentId,
        displayName: agentNameById.get(agentId) || agentId,
        approvals,
      }))
      .sort((a, b) => a.displayName.localeCompare(b.displayName));
  }, [agentNameById, botApprovals]);
  const receivedCount = pendingReceived.length + botApprovals.length;
  const receivedLoading = contactRequestsLoading || botApprovalsLoading;

  const resolveBotApproval = useCallback(
    async (approvalId: string, decision: "approve" | "reject") => {
      setBotApprovalAction({ id: approvalId, decision });
      setBotApprovalsError(null);
      try {
        await humansApi.resolvePendingApproval(approvalId, decision);
        setBotApprovals((prev) => prev.filter((approval) => approval.id !== approvalId));
      } catch (err: any) {
        setBotApprovalsError(err?.message || (locale === "zh" ? "处理 Bot 请求失败" : "Failed to resolve bot request"));
      } finally {
        setBotApprovalAction(null);
      }
    },
    [locale],
  );

  return (
    <div className="flex h-full flex-col">
      {(title || !hideTabs) && (
        <div className="flex items-center justify-between gap-3 border-b border-glass-border px-5 py-3">
          {title ? <div className="min-w-0 text-sm font-semibold text-text-primary">{title}</div> : <span />}
          {!hideTabs ? (
            <div className="inline-flex items-center gap-1 rounded-full border border-glass-border bg-glass-bg/50 p-0.5">
              <TabButton
                active={tab === "received"}
                onClick={() => setTab("received")}
                icon={<Mail className="h-3 w-3" />}
                label={t.requestsTabReceived}
                count={receivedCount}
              />
              <TabButton
                active={tab === "sent"}
                onClick={() => setTab("sent")}
                icon={<Send className="h-3 w-3" />}
                label={t.requestsTabSent}
                count={visibleSent.length}
              />
            </div>
          ) : null}
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-5 py-4">
        {tab === "received" ? (
          receivedLoading && receivedCount === 0 ? (
            <p className="animate-pulse text-xs text-text-secondary">...</p>
          ) : receivedCount === 0 ? (
            <p className="text-xs text-text-secondary">
              {emptyHint ?? t.noPendingRequests}
            </p>
          ) : (
            <div className="space-y-5">
              {pendingReceived.length > 0 ? (
                <section>
                  <SectionLabel>
                    {locale === "zh" ? "发给我的请求" : "Requests to me"}
                  </SectionLabel>
                  <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
                    {pendingReceived.map((req) => (
                      <ReceivedRequestCard
                        key={req.id}
                        req={req}
                        locale={locale}
                        t={t}
                        isProcessing={processingContactRequestId === req.id}
                        isAccepting={processingContactRequestId === req.id && processingContactRequestAction === "accept"}
                        isRejecting={processingContactRequestId === req.id && processingContactRequestAction === "reject"}
                        onRespond={respondContactRequest}
                      />
                    ))}
                  </div>
                </section>
              ) : null}

              {botApprovalGroups.length > 0 ? (
                <section>
                  <SectionLabel>
                    {locale === "zh" ? "我的 Bot 收到的请求" : "Requests to my bots"}
                  </SectionLabel>
                  <div className="space-y-3">
                    {botApprovalGroups.map((group) => {
                      const expanded = expandedBotGroups[group.agentId] ?? true;
                      return (
                        <div
                          key={group.agentId}
                          className="overflow-hidden rounded-2xl border border-glass-border bg-deep-black-light"
                        >
                          <button
                            type="button"
                            onClick={() =>
                              setExpandedBotGroups((prev) => ({
                                ...prev,
                                [group.agentId]: !(prev[group.agentId] ?? true),
                              }))
                            }
                            className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-glass-bg/50"
                          >
                            <BotAvatar agentId={group.agentId} alt={group.displayName} size={36} />
                            <div className="min-w-0 flex-1">
                              <p className="truncate text-sm font-semibold text-text-primary">
                                {group.displayName}
                              </p>
                              <p className="truncate font-mono text-[11px] text-text-secondary/60">
                                {group.agentId}
                              </p>
                            </div>
                            <span className="rounded-full bg-neon-cyan px-1.5 text-[10px] font-bold text-black">
                              {group.approvals.length}
                            </span>
                            <ChevronDown
                              className={`h-4 w-4 shrink-0 text-text-secondary transition-transform ${expanded ? "rotate-180" : ""}`}
                            />
                          </button>
                          {expanded ? (
                            <div className="grid grid-cols-1 gap-3 border-t border-glass-border p-3 md:grid-cols-2 xl:grid-cols-3">
                              {group.approvals.map((approval) => (
                                <BotApprovalCard
                                  key={approval.id}
                                  approval={approval}
                                  locale={locale}
                                  t={t}
                                  isApproving={botApprovalAction?.id === approval.id && botApprovalAction.decision === "approve"}
                                  isRejecting={botApprovalAction?.id === approval.id && botApprovalAction.decision === "reject"}
                                  onResolve={resolveBotApproval}
                                />
                              ))}
                            </div>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                </section>
              ) : null}

              {botApprovalsError ? (
                <p className="text-xs text-red-300">{botApprovalsError}</p>
              ) : null}
            </div>
          )
        ) : visibleSent.length === 0 ? (
          <p className="text-xs text-text-secondary">{t.noSentRequests}</p>
        ) : (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {visibleSent.map((req) => (
              <SentRequestCard key={req.id} req={req} locale={locale} t={t} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div className="mb-2 flex items-center gap-2">
      <span className="text-xs font-semibold text-text-primary">{children}</span>
    </div>
  );
}

function isHumanId(id: string) {
  return id.startsWith("hu_") || id.startsWith("hm_");
}

function payloadString(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === "string" && value.trim() ? value : null;
}

function ReceivedRequestCard({
  req,
  locale,
  t,
  isProcessing,
  isAccepting,
  isRejecting,
  onRespond,
}: {
  req: ContactRequestItem;
  locale: Locale;
  t: typeof chatPane.en;
  isProcessing: boolean;
  isAccepting: boolean;
  isRejecting: boolean;
  onRespond: (requestId: number | string, action: "accept" | "reject") => Promise<void>;
}) {
  const isHuman = isHumanId(req.from_agent_id);
  const initial = (req.from_display_name || req.from_agent_id).trim().charAt(0).toUpperCase();
  return (
    <div className="rounded-2xl border border-glass-border bg-deep-black-light p-4">
      <div className="flex items-start gap-3">
        {isHuman ? (
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-neon-purple/15 text-sm font-semibold text-neon-purple">
            {initial || "?"}
          </div>
        ) : (
          <BotAvatar agentId={req.from_agent_id} alt={req.from_display_name ?? undefined} size={40} />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="truncate text-sm font-semibold text-text-primary">
              {req.from_display_name || req.from_agent_id}
            </p>
            <TypeBadge isHuman={isHuman} locale={locale} />
          </div>
          <p className="mt-0.5 truncate font-mono text-[11px] text-text-secondary/60">
            {req.from_agent_id}
          </p>
        </div>
      </div>
      <p className="mt-3 line-clamp-3 min-h-[48px] text-xs text-text-secondary">
        {req.message || t.noRequestMessage}
      </p>
      <div className="mt-3 flex items-center gap-2">
        <button
          onClick={() => onRespond(req.id, "accept")}
          disabled={isProcessing}
          className="inline-flex items-center gap-1.5 rounded border border-neon-green/40 bg-neon-green/10 px-3 py-1 text-xs text-neon-green disabled:opacity-50"
        >
          {isAccepting ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
          {isAccepting ? t.accepting : t.accept}
        </button>
        <button
          onClick={() => onRespond(req.id, "reject")}
          disabled={isProcessing}
          className="inline-flex items-center gap-1.5 rounded border border-red-400/40 bg-red-400/10 px-3 py-1 text-xs text-red-300 disabled:opacity-50"
        >
          {isRejecting ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
          {isRejecting ? t.rejecting : t.reject}
        </button>
      </div>
    </div>
  );
}

function BotApprovalCard({
  approval,
  locale,
  t,
  isApproving,
  isRejecting,
  onResolve,
}: {
  approval: PendingApproval;
  locale: Locale;
  t: typeof chatPane.en;
  isApproving: boolean;
  isRejecting: boolean;
  onResolve: (approvalId: string, decision: "approve" | "reject") => Promise<void>;
}) {
  const fromId = payloadString(approval.payload, "from_participant_id") || "unknown";
  const fromName = payloadString(approval.payload, "from_display_name") || fromId;
  const message = payloadString(approval.payload, "message");
  const isHuman = payloadString(approval.payload, "from_type") === "human" || isHumanId(fromId);
  const initial = fromName.trim().charAt(0).toUpperCase();
  const processing = isApproving || isRejecting;

  return (
    <div className="rounded-xl border border-glass-border bg-deep-black p-4">
      <div className="flex items-start gap-3">
        {isHuman ? (
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-neon-purple/15 text-sm font-semibold text-neon-purple">
            {initial || "?"}
          </div>
        ) : (
          <BotAvatar agentId={fromId} alt={fromName} size={40} />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="truncate text-sm font-semibold text-text-primary">{fromName}</p>
            <TypeBadge isHuman={isHuman} locale={locale} />
          </div>
          <p className="mt-0.5 truncate font-mono text-[11px] text-text-secondary/60">
            {fromId}
          </p>
        </div>
      </div>
      <p className="mt-3 line-clamp-3 min-h-[48px] text-xs text-text-secondary">
        {message || t.noRequestMessage}
      </p>
      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          onClick={() => onResolve(approval.id, "approve")}
          disabled={processing}
          className="inline-flex items-center gap-1.5 rounded border border-neon-green/40 bg-neon-green/10 px-3 py-1 text-xs text-neon-green disabled:opacity-50"
        >
          {isApproving ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
          {isApproving ? t.accepting : t.accept}
        </button>
        <button
          type="button"
          onClick={() => onResolve(approval.id, "reject")}
          disabled={processing}
          className="inline-flex items-center gap-1.5 rounded border border-red-400/40 bg-red-400/10 px-3 py-1 text-xs text-red-300 disabled:opacity-50"
        >
          {isRejecting ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
          {isRejecting ? t.rejecting : t.reject}
        </button>
      </div>
    </div>
  );
}

function SentRequestCard({
  req,
  locale,
  t,
}: {
  req: ContactRequestItem;
  locale: Locale;
  t: typeof chatPane.en;
}) {
  const stateLabel =
    req.state === "pending"
      ? t.sentRequestPending
      : req.state === "accepted"
        ? t.sentRequestAccepted
        : t.sentRequestRejected;
  const stateClass =
    req.state === "pending"
      ? "border-amber-400/40 bg-amber-400/10 text-amber-300"
      : req.state === "accepted"
        ? "border-neon-green/40 bg-neon-green/10 text-neon-green"
        : "border-red-400/40 bg-red-400/10 text-red-300";
  const toIsHuman = isHumanId(req.to_agent_id);
  const toInitial = (req.to_display_name || req.to_agent_id).trim().charAt(0).toUpperCase();

  return (
    <div className="rounded-2xl border border-glass-border bg-deep-black-light p-4">
      <div className="flex items-start gap-3">
        {toIsHuman ? (
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-neon-purple/15 text-sm font-semibold text-neon-purple">
            {toInitial || "?"}
          </div>
        ) : (
          <BotAvatar agentId={req.to_agent_id} alt={req.to_display_name ?? undefined} size={40} />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="truncate text-sm font-semibold text-text-primary">
              {req.to_display_name || req.to_agent_id}
            </p>
            <TypeBadge isHuman={toIsHuman} locale={locale} />
          </div>
          <p className="mt-0.5 truncate font-mono text-[11px] text-text-secondary/60">
            {req.to_agent_id}
          </p>
        </div>
        <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-medium ${stateClass}`}>
          {stateLabel}
        </span>
      </div>
      <p className="mt-3 line-clamp-3 min-h-[48px] text-xs text-text-secondary">
        {req.message || t.noRequestMessage}
      </p>
      <p className="mt-3 text-[10px] text-text-secondary/50">
        {new Date(req.created_at).toLocaleString()}
      </p>
    </div>
  );
}

function TypeBadge({ isHuman, locale }: { isHuman: boolean; locale: Locale }) {
  return (
    <span
      className={`shrink-0 rounded-full border px-1.5 py-px text-[9px] font-medium uppercase tracking-wider ${
        isHuman
          ? "border-neon-purple/30 bg-neon-purple/10 text-neon-purple"
          : "border-neon-cyan/30 bg-neon-cyan/10 text-neon-cyan"
      }`}
    >
      {isHuman ? (locale === "zh" ? "真人" : "Human") : "Bot"}
    </span>
  );
}

function TabButton({
  active,
  onClick,
  icon,
  label,
  count,
}: {
  active: boolean;
  onClick: () => void;
  icon: ReactNode;
  label: string;
  count: number;
}) {
  return (
    <button
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[11px] font-medium transition-colors ${
        active
          ? "bg-text-primary text-deep-black"
          : "text-text-secondary hover:text-text-primary"
      }`}
    >
      {icon}
      {label}
      {count > 0 ? (
        <span
          className={`rounded-full px-1.5 text-[10px] font-semibold ${
            active ? "bg-deep-black/15 text-deep-black" : "bg-text-secondary/15 text-text-secondary/80"
          }`}
        >
          {count}
        </span>
      ) : null}
    </button>
  );
}
