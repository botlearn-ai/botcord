/**
 * [INPUT]: 依赖 api 层获取入群申请列表，依赖 roomList i18n 文案
 * [OUTPUT]: 对外提供 JoinRequestsPanel 组件，展示并管理当前房间的入群申请（accept/reject）
 * [POS]: dashboard 右侧面板的子模块，嵌入 AgentBrowser 中供群主/管理员消费
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useLanguage } from "@/lib/i18n";
import { roomList } from "@/lib/i18n/translations/dashboard";
import type { JoinRequestItem } from "@/lib/types";
import CopyableId from "@/components/ui/CopyableId";

interface JoinRequestsPanelProps {
  roomId: string;
}

export default function JoinRequestsPanel({ roomId }: JoinRequestsPanelProps) {
  const locale = useLanguage();
  const t = roomList[locale];
  const [requests, setRequests] = useState<JoinRequestItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [processingId, setProcessingId] = useState<string | null>(null);

  const loadRequests = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.getJoinRequests(roomId);
      setRequests(res.requests);
    } catch {
      setRequests([]);
    } finally {
      setLoading(false);
    }
  }, [roomId]);

  useEffect(() => {
    void loadRequests();
  }, [loadRequests]);

  const handleAccept = async (requestId: string) => {
    setProcessingId(requestId);
    try {
      await api.acceptJoinRequest(roomId, requestId);
      setRequests((prev) => prev.filter((r) => r.request_id !== requestId));
    } catch {
      // keep item in list on failure
    } finally {
      setProcessingId(null);
    }
  };

  const handleReject = async (requestId: string) => {
    setProcessingId(requestId);
    try {
      await api.rejectJoinRequest(roomId, requestId);
      setRequests((prev) => prev.filter((r) => r.request_id !== requestId));
    } catch {
      // keep item in list on failure
    } finally {
      setProcessingId(null);
    }
  };

  if (loading) {
    return (
      <p className="px-2 py-1 text-xs text-text-secondary animate-pulse">
        {t.joinRequests}...
      </p>
    );
  }

  if (requests.length === 0) {
    return (
      <p className="px-2 py-1 text-xs text-text-secondary/60">
        {t.noJoinRequests}
      </p>
    );
  }

  return (
    <div className="space-y-2">
      {requests.map((req) => {
        const isProcessing = processingId === req.request_id;
        return (
          <div
            key={req.request_id}
            className="rounded-lg border border-glass-border bg-glass-bg/30 px-3 py-2"
          >
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="truncate text-xs font-medium text-text-primary">
                  {req.agent_display_name || req.agent_id}
                </p>
                <CopyableId value={req.agent_id} />
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <button
                  onClick={() => void handleAccept(req.request_id)}
                  disabled={isProcessing}
                  className="rounded border border-neon-green/40 bg-neon-green/10 px-2 py-1 text-[10px] font-medium text-neon-green transition-colors hover:bg-neon-green/20 disabled:opacity-50"
                >
                  {isProcessing ? t.accepting : t.accept}
                </button>
                <button
                  onClick={() => void handleReject(req.request_id)}
                  disabled={isProcessing}
                  className="rounded border border-red-400/40 bg-red-400/10 px-2 py-1 text-[10px] font-medium text-red-400 transition-colors hover:bg-red-400/20 disabled:opacity-50"
                >
                  {isProcessing ? t.rejecting : t.reject}
                </button>
              </div>
            </div>
            {req.message && (
              <p className="mt-1 text-[11px] text-text-secondary/80 line-clamp-2">
                {req.message}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}
