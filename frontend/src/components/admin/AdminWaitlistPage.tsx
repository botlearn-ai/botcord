"use client";

/**
 * [INPUT]: 依赖 adminBetaApi (getWaitlist/approveWaitlist/rejectWaitlist)
 * [OUTPUT]: Admin 等待列表审批页 — 申请列表 + 通过/拒绝操作，过滤请求隔离及后台刷新
 */

import Alert from "@/components/ui/Alert";
import Tabs from "@/components/ui/Tabs";
import IconButton from "@/components/ui/IconButton";
import Button from "@/components/ui/Button";
import Table, { TableHead, TableBody, TableRow, TableHeader, TableCell } from "@/components/ui/Table";
import { useMemo, useEffect, useState } from "react";
import { Loader2, CheckCircle, XCircle, Copy } from "lucide-react";
import { adminBetaApi, type BetaWaitlistEntry } from "@/lib/api";
import { useStore } from "zustand";
import { createAdminListStore } from "./admin-list-store";
import { useConfirm } from "@/store/useConfirmStore";

type StatusFilter = "pending" | "approved" | "rejected";

export default function AdminWaitlistPage() {
  const confirm = useConfirm();
  const store = useMemo(() => createAdminListStore<BetaWaitlistEntry>(key => adminBetaApi.getWaitlist(key as StatusFilter).then((data) => data.entries)), []);
  const { rows, key, loading: fetching, error, setError } = useStore(store);
  const [filter, setFilter] = useState<StatusFilter>("pending");
  const entries = key === filter ? rows : [];
  const loading = fetching || key !== filter;
  const [pendingAction, setPendingAction] = useState<string | null>(null);

  // Stores { entryId: { code, emailSent } } for failed email cases
  const [failedEmailCodes, setFailedEmailCodes] = useState<Record<string, string>>({});
  const [recentFailedApprovals, setRecentFailedApprovals] = useState<BetaWaitlistEntry[]>([]);

  const fetchEntries = store.getState().refresh;
  useEffect(() => {
    void store.getState().load(filter);
    return () => store.getState().cancel();
  }, [store, filter]);

  async function handleApprove(id: string) {
    setPendingAction(id);
    try {
      const result = await adminBetaApi.approveWaitlist(id);
      if (!result.email_sent) {
        setFailedEmailCodes((prev) => ({ ...prev, [id]: result.code }));
        setRecentFailedApprovals((prev) => [
          result.entry,
          ...prev.filter((entry) => entry.id !== result.entry.id),
        ]);
      }
      await fetchEntries();
    } catch (err: any) {
      setError(err?.message ?? "审批失败");
    } finally {
      setPendingAction(null);
    }
  }

  async function handleReject(id: string) {
    if (!(await confirm({ title: "确认拒绝此申请？", tone: "danger" }))) return;
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
      <h2 className="text-xl font-semibold text-text-primary">等待列表</h2>

      <Tabs value={filter} onValueChange={(value) => setFilter(value as StatusFilter)} ariaLabel="申请状态" items={tabs.map((tab) => ({ value: tab.key, label: tab.label }))} />

      {error && (
        <Alert tone="danger" >{error}</Alert>
      )}

      {recentFailedApprovals.length > 0 && (
        <Alert tone="warning" className="space-y-3">
          <div>
            <p className="text-sm font-medium text-amber-200">以下审批未能完成邮件发送</p>
            <p className="text-xs text-warning/80">请复制激活码，通过其他渠道手动发送给申请人。</p>
          </div>
          <div className="space-y-2">
            {recentFailedApprovals.map((entry) => (
              <div
                key={entry.id}
                className="flex flex-wrap items-center gap-2" >
                <span className="text-xs text-text-primary">{entry.email}</span>
                <span className="text-xs text-warning">激活码：</span>
                <span className="font-mono text-xs text-neon-cyan">{failedEmailCodes[entry.id]}</span>
                <IconButton label="复制邀请码"
                  onClick={() => navigator.clipboard.writeText(failedEmailCodes[entry.id])} >
                  <Copy className="h-3 w-3" />
                </IconButton>
              </div>
            ))}
          </div>
        </Alert>
      )}

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-text-secondary">
          <Loader2 className="h-4 w-4 animate-spin" />
          加载中…
        </div>
      ) : (
        <div className="min-w-0">
          <Table aria-label="等待列表">
            <TableHead >
              <TableRow>
                <TableHeader >邮箱</TableHeader>
                <TableHeader >说明</TableHeader>
                <TableHeader >申请时间</TableHeader>
                {filter === "approved" && (
                  <TableHeader >已发激活码</TableHeader>
                )}
                {filter === "pending" && (
                  <TableHeader >操作</TableHeader>
                )}
              </TableRow>
            </TableHead>
            <TableBody>
              {entries.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-center">暂无申请</TableCell>
                </TableRow>
              ) : (
                entries.map((e) => (
                  <TableRow key={e.id} >
                    <TableCell >{e.email}</TableCell>
                    <TableCell className="max-w-[200px] truncate">{e.note || "—"}</TableCell>
                    <TableCell >
                      {new Date(e.applied_at).toLocaleDateString("zh-CN")}
                    </TableCell>
                    {filter === "approved" && (
                      <TableCell >
                        {e.sent_code ? (
                          <span className="font-mono text-xs text-neon-cyan">{e.sent_code}</span>
                        ) : (
                          <span className="text-xs text-text-secondary">—</span>
                        )}
                      </TableCell>
                    )}
                    {filter === "pending" && (
                      <TableCell >
                        <div className="space-y-2">
                          <div className="flex items-center gap-2">
                            <Button variant="secondary" size="sm"
                              onClick={() => handleApprove(e.id)}
                              disabled={pendingAction === e.id} >
                              {pendingAction === e.id ? (
                                <Loader2 className="h-3 w-3 animate-spin" />
                              ) : (
                                <CheckCircle className="h-3 w-3" />
                              )}
                              通过
                            </Button>
                            <Button variant="danger" size="sm"
                              onClick={() => handleReject(e.id)}
                              disabled={pendingAction === e.id} >
                              <XCircle className="h-3 w-3" />
                              拒绝
                            </Button>
                          </div>
                          {failedEmailCodes[e.id] && (
                            <Alert tone="warning" className="flex items-center gap-2">
                              <span className="text-xs text-warning">邮件发送失败，激活码：</span>
                              <span className="font-mono text-xs text-neon-cyan">{failedEmailCodes[e.id]}</span>
                              <IconButton label="复制邀请码"
                                onClick={() => navigator.clipboard.writeText(failedEmailCodes[e.id])} >
                                <Copy className="h-3 w-3" />
                              </IconButton>
                            </Alert>
                          )}
                        </div>
                      </TableCell>
                    )}
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
