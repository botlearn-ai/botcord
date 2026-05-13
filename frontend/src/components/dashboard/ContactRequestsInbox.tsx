"use client";

/**
 * [INPUT]: 依赖 contact store 的 received/sent requests + respondContactRequest 动作；本地状态控制 received/sent sub-tab
 * [OUTPUT]: ContactRequestsInbox — 联系人申请收件箱，包含 Received / Sent 双 tab、状态徽章、accept/reject inline 操作；可被 ChatPane 与 Messages inline 入口共用
 * [POS]: 联系人申请处理模块的复用组件
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

import { useEffect, useState, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import { Loader2, Mail, Send } from "lucide-react";
import { useDashboardContactStore } from "@/store/useDashboardContactStore";
import { useDashboardSessionStore } from "@/store/useDashboardSessionStore";
import { useLanguage } from "@/lib/i18n";
import { chatPane } from "@/lib/i18n/translations/dashboard";
import BotAvatar from "./BotAvatar";

type Tab = "received" | "sent";

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
  const isAuthed = useDashboardSessionStore(
    (s) => s.sessionMode === "authed-ready" || s.sessionMode === "authed-no-agent",
  );

  useEffect(() => {
    if (isAuthed) void loadContactRequests();
  }, [isAuthed, loadContactRequests]);

  const [tab, setTab] = useState<Tab>(initialTab);

  const pendingReceived = contactRequestsReceived.filter((r) => r.state === "pending");
  const visibleSent = contactRequestsSent;
  const activeList = tab === "received" ? pendingReceived : visibleSent;

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
                count={pendingReceived.length}
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
        {contactRequestsLoading && activeList.length === 0 ? (
          <p className="animate-pulse text-xs text-text-secondary">…</p>
        ) : activeList.length === 0 ? (
          <p className="text-xs text-text-secondary">
            {tab === "received" ? (emptyHint ?? t.noPendingRequests) : t.noSentRequests}
          </p>
        ) : (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {activeList.map((req) => {
              const isProcessing = processingContactRequestId === req.id;
              const isAccepting = isProcessing && processingContactRequestAction === "accept";
              const isRejecting = isProcessing && processingContactRequestAction === "reject";

              if (tab === "received") {
                const isHuman =
                  req.from_agent_id.startsWith("hu_") || req.from_agent_id.startsWith("hm_");
                const initial = (req.from_display_name || req.from_agent_id).trim().charAt(0).toUpperCase();
                return (
                  <div
                    key={req.id}
                    className="rounded-2xl border border-glass-border bg-deep-black-light p-4"
                  >
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
                          <span
                            className={`shrink-0 rounded-full border px-1.5 py-px text-[9px] font-medium uppercase tracking-wider ${
                              isHuman
                                ? "border-neon-purple/30 bg-neon-purple/10 text-neon-purple"
                                : "border-neon-cyan/30 bg-neon-cyan/10 text-neon-cyan"
                            }`}
                          >
                            {isHuman ? (locale === "zh" ? "真人" : "Human") : "Bot"}
                          </span>
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
                        onClick={() => respondContactRequest(req.id, "accept")}
                        disabled={isProcessing}
                        className="inline-flex items-center gap-1.5 rounded border border-neon-green/40 bg-neon-green/10 px-3 py-1 text-xs text-neon-green disabled:opacity-50"
                      >
                        {isAccepting ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                        {isAccepting ? t.accepting : t.accept}
                      </button>
                      <button
                        onClick={() => respondContactRequest(req.id, "reject")}
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

              // sent
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
              const toIsHuman =
                req.to_agent_id.startsWith("hu_") || req.to_agent_id.startsWith("hm_");
              const toInitial = (req.to_display_name || req.to_agent_id).trim().charAt(0).toUpperCase();
              return (
                <div
                  key={req.id}
                  className="rounded-2xl border border-glass-border bg-deep-black-light p-4"
                >
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
                        <span
                          className={`shrink-0 rounded-full border px-1.5 py-px text-[9px] font-medium uppercase tracking-wider ${
                            toIsHuman
                              ? "border-neon-purple/30 bg-neon-purple/10 text-neon-purple"
                              : "border-neon-cyan/30 bg-neon-cyan/10 text-neon-cyan"
                          }`}
                        >
                          {toIsHuman ? (locale === "zh" ? "真人" : "Human") : "Bot"}
                        </span>
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
            })}
          </div>
        )}
      </div>
    </div>
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
