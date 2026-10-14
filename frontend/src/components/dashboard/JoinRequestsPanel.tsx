/**
 * [INPUT]: 依赖 api 层获取加入房间申请列表，依赖 roomList i18n 文案
 * [OUTPUT]: 对外提供 JoinRequestsPanel 组件，展示并管理当前房间的加入申请（accept/reject）
 * [POS]: dashboard 右侧面板的子模块，嵌入 AgentBrowser 中供房主/管理员消费
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */
"use client";

import Card from "@/components/ui/Card";
import Button from "@/components/ui/Button";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useLanguage } from "@/lib/i18n";
import { roomList } from "@/lib/i18n/translations/dashboard";
import type { JoinRequestItem } from "@/lib/types";
import { BotCordLoadingBlock } from "@/components/ui/BotCordLoader";
import { Loader2 } from "lucide-react";

interface JoinRequestsPanelProps {
  roomId: string;
}

export default function JoinRequestsPanel({ roomId }: JoinRequestsPanelProps) {
  const locale = useLanguage();
  const t = roomList[locale];
  const [requests, setRequests] = useState<JoinRequestItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [processingId, setProcessingId] = useState<string | null>(null);
  const [processingAction, setProcessingAction] = useState<"accept" | "reject" | null>(null);

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
    setProcessingAction("accept");
    try {
      await api.acceptJoinRequest(roomId, requestId);
      setRequests((prev) => prev.filter((r) => r.request_id !== requestId));
    } catch {
      // keep item in list on failure
    } finally {
      setProcessingId(null);
      setProcessingAction(null);
    }
  };

  const handleReject = async (requestId: string) => {
    setProcessingId(requestId);
    setProcessingAction("reject");
    try {
      await api.rejectJoinRequest(roomId, requestId);
      setRequests((prev) => prev.filter((r) => r.request_id !== requestId));
    } catch {
      // keep item in list on failure
    } finally {
      setProcessingId(null);
      setProcessingAction(null);
    }
  };

  if (loading) {
    return (
      <BotCordLoadingBlock
        label={`${t.joinRequests}...`}
        className="px-2 py-1 justify-start"
      />
    );
  }

  if (requests.length === 0) {
    return (
      <p className="px-2 py-1 text-xs text-text-secondary">
        {t.noJoinRequests}
      </p>
    );
  }

  return (
    <div className="space-y-2">
      {requests.map((req) => {
        const isProcessing = processingId === req.request_id;
        const isAccepting = isProcessing && processingAction === "accept";
        const isRejecting = isProcessing && processingAction === "reject";
        return (
          <Card padding="sm"
            key={req.request_id}
            className=""
          >
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="truncate text-xs font-medium text-text-primary">
                  {req.agent_display_name || req.agent_id}
                </p>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <Button variant="secondary" size="sm"
                  onClick={() => void handleAccept(req.request_id)}
                  disabled={isProcessing}
                  className="inline-flex items-center gap-1 disabled:opacity-50"
                >
                  {isAccepting ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                  {isAccepting ? t.accepting : t.accept}
                </Button>
                <Button variant="danger" size="sm"
                  onClick={() => void handleReject(req.request_id)}
                  disabled={isProcessing}
                  className="inline-flex items-center gap-1 disabled:opacity-50"
                >
                  {isRejecting ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                  {isRejecting ? t.rejecting : t.reject}
                </Button>
              </div>
            </div>
            {req.message && (
              <p className="mt-1 text-xs text-text-secondary line-clamp-2">
                {req.message}
              </p>
            )}
          </Card>
        );
      })}
    </div>
  );
}
