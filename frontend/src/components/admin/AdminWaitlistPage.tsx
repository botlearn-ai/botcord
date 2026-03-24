"use client";

/**
 * [INPUT]: 依赖 adminBetaApi (getWaitlist/approveWaitlist/rejectWaitlist)
 * [OUTPUT]: Admin 等待列表审批页 — 申请列表 + 通过/拒绝操作
 */

import { useCallback, useEffect, useState } from "react";
import { Loader2, CheckCircle, XCircle, Copy } from "lucide-react";
import { adminBetaApi, type BetaWaitlistEntry } from "@/lib/api";

type StatusFilter = "pending" | "approved" | "rejected";

export default function AdminWaitlistPage() {
  const [entries, setEntries] = useState<BetaWaitlistEntry[]>([]);
  const [filter, setFilter] = useState<StatusFilter>("pending");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);

  // Stores { entryId: { code, emailSent } } for failed email cases
  const [failedEmailCodes, setFailedEmailCodes] = useState<Record<string, string>>({});

  const fetchEntries = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await adminBetaApi.getWaitlist(filter);
      setEntries(data.entries);
    } catch (err: any) {
      setError(err?.message ?? "加载失败");
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => { fetchEntries(); }, [fetchEntries]);

  async function handleApprove(id: string) {
    setPendingAction(id);
    try {
      const result = await adminBetaApi.approveWaitlist(id);
      if (!result.email_sent) {
        setFailedEmailCodes((prev) => ({ ...prev, [id]: result.code }));
      }
      await fetchEntries();
    } catch (err: any) {
      setError(err?.message ?? "审批失败");
    } finally {
      setPendingAction(null);
    }
  }

  async function handleReject(id: string) {
    if (!confirm("确认拒绝此申请？")) return;
    setPendingAction(id);
    try {
      await adminBetaApi.rejectWaitlist(id);
      await fetchEntries();
    } catch (err: any) {
      setError(err?.message ?? "拒绝失败");
    } finally {
      setPendingAction(null);
    }
  }

  const tabs: { key: StatusFilter; label: string }[] = [
    { key: "pending", label: "待审核" },
    { key: "approved", label: "已通过" },
    { key: "rejected", label: "已拒绝" },
  ];

  return (
    <div className="space-y-6">
      <h2 className="text-xl font-bold text-text-primary">等待列表</h2>

      <div className="flex gap-1 rounded-xl border border-glass-border bg-deep-black-light p-1 w-fit">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setFilter(tab.key)}
            className={`rounded-lg px-4 py-1.5 text-sm font-medium transition-colors ${
              filter === tab.key
                ? "bg-neon-cyan/10 text-neon-cyan"
                : "text-text-secondary hover:text-text-primary"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {error && (
        <p className="rounded-xl border border-red-400/20 bg-red-400/10 px-4 py-2 text-sm text-red-300">{error}</p>
      )}

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-text-secondary">
          <Loader2 className="h-4 w-4 animate-spin" />
          加载中…
        </div>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-glass-border">
          <table className="w-full text-sm">
            <thead className="border-b border-glass-border bg-glass-bg">
              <tr>
                <th className="px-4 py-3 text-left text-xs text-text-secondary">邮箱</th>
                <th className="px-4 py-3 text-left text-xs text-text-secondary">说明</th>
                <th className="px-4 py-3 text-left text-xs text-text-secondary">申请时间</th>
                {filter === "approved" && (
                  <th className="px-4 py-3 text-left text-xs text-text-secondary">已发激活码</th>
                )}
                {filter === "pending" && (
                  <th className="px-4 py-3 text-left text-xs text-text-secondary">操作</th>
                )}
              </tr>
            </thead>
            <tbody>
              {entries.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-text-secondary">暂无申请</td>
                </tr>
              ) : (
                entries.map((e) => (
                  <tr key={e.id} className="border-b border-glass-border/50 last:border-0">
                    <td className="px-4 py-3 text-text-primary">{e.email}</td>
                    <td className="px-4 py-3 text-xs text-text-secondary max-w-[200px] truncate">{e.note || "—"}</td>
                    <td className="px-4 py-3 text-xs text-text-secondary">
                      {new Date(e.applied_at).toLocaleDateString("zh-CN")}
                    </td>
                    {filter === "approved" && (
                      <td className="px-4 py-3">
                        {e.sent_code ? (
                          <span className="font-mono text-xs text-neon-cyan">{e.sent_code}</span>
                        ) : (
                          <span className="text-xs text-text-tertiary">—</span>
                        )}
                      </td>
                    )}
                    {filter === "pending" && (
                      <td className="px-4 py-3">
                        <div className="space-y-2">
                          <div className="flex items-center gap-2">
                            <button
                              onClick={() => handleApprove(e.id)}
                              disabled={pendingAction === e.id}
                              className="flex items-center gap-1 rounded-lg bg-neon-cyan/10 px-3 py-1 text-xs font-medium text-neon-cyan transition-colors hover:bg-neon-cyan/20 disabled:opacity-50"
                            >
                              {pendingAction === e.id ? (
                                <Loader2 className="h-3 w-3 animate-spin" />
                              ) : (
                                <CheckCircle className="h-3 w-3" />
                              )}
                              通过
                            </button>
                            <button
                              onClick={() => handleReject(e.id)}
                              disabled={pendingAction === e.id}
                              className="flex items-center gap-1 rounded-lg border border-glass-border px-3 py-1 text-xs text-text-secondary transition-colors hover:text-red-300 disabled:opacity-50"
                            >
                              <XCircle className="h-3 w-3" />
                              拒绝
                            </button>
                          </div>
                          {failedEmailCodes[e.id] && (
                            <div className="flex items-center gap-2 rounded-lg border border-amber-400/20 bg-amber-400/10 px-3 py-1.5">
                              <span className="text-xs text-amber-300">邮件发送失败，激活码：</span>
                              <span className="font-mono text-xs text-neon-cyan">{failedEmailCodes[e.id]}</span>
                              <button
                                onClick={() => navigator.clipboard.writeText(failedEmailCodes[e.id])}
                                className="text-text-secondary hover:text-text-primary"
                              >
                                <Copy className="h-3 w-3" />
                              </button>
                            </div>
                          )}
                        </div>
                      </td>
                    )}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
