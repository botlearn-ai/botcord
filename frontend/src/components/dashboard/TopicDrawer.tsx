"use client";

/**
 * [INPUT]: 依赖 chat/ui/session store 的消息和焦点状态，复用 MessageBubble 和 RoomHumanComposer 渲染话题线程
 * [OUTPUT]: 对外提供 TopicDrawer 组件，作为从右侧滑出的话题详情面板
 * [POS]: dashboard 聊天正文区的话题线程查看/回复面板，避免话题消息在主列表铺开造成视觉杂乱
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

import { useEffect, useMemo, useRef } from "react";
import { X } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useLanguage } from "@/lib/i18n";
import { messageList } from "@/lib/i18n/translations/dashboard";
import { useDashboardChatStore } from "@/store/useDashboardChatStore";
import { useDashboardSessionStore } from "@/store/useDashboardSessionStore";
import { useDashboardUIStore } from "@/store/useDashboardUIStore";
import MessageBubble from "./MessageBubble";
import RoomHumanComposer from "./RoomHumanComposer";

const topicStatusColors: Record<string, { color: string; icon: string }> = {
  open:      { color: "text-neon-cyan bg-neon-cyan/10 border-neon-cyan/30",    icon: "●" },
  completed: { color: "text-green-400 bg-green-400/10 border-green-400/30",    icon: "✔" },
  failed:    { color: "text-red-400 bg-red-400/10 border-red-400/30",          icon: "✗" },
  expired:   { color: "text-yellow-400 bg-yellow-400/10 border-yellow-400/30", icon: "⏱" },
};

export default function TopicDrawer() {
  const locale = useLanguage();
  const t = messageList[locale];

  const { openedRoomId, openedTopicId, setOpenedTopicId } = useDashboardUIStore(
    useShallow((state) => ({
      openedRoomId: state.openedRoomId,
      openedTopicId: state.openedTopicId,
      setOpenedTopicId: state.setOpenedTopicId,
    })),
  );
  const messagesByRoom = useDashboardChatStore((s) => s.messages);
  const activeAgentId = useDashboardSessionStore((s) => s.activeAgentId);

  const bottomRef = useRef<HTMLDivElement>(null);

  const { topicMessages, topicName, topicStatus, topicGoal } = useMemo(() => {
    if (!openedRoomId || !openedTopicId) {
      return { topicMessages: [], topicName: "", topicStatus: null as string | null, topicGoal: null as string | null };
    }
    const all = messagesByRoom[openedRoomId] || [];
    const filtered = all.filter((m) => m.topic_id === openedTopicId);
    const first = filtered[0];
    return {
      topicMessages: filtered,
      topicName: first?.topic_title || first?.topic || openedTopicId,
      topicStatus: first?.topic_status || null,
      topicGoal: first?.topic_goal || null,
    };
  }, [messagesByRoom, openedRoomId, openedTopicId]);

  useEffect(() => {
    if (openedTopicId) {
      bottomRef.current?.scrollIntoView({ behavior: "auto" });
    }
  }, [openedTopicId, topicMessages.length]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpenedTopicId(null);
    };
    if (openedTopicId) {
      window.addEventListener("keydown", onKey);
      return () => window.removeEventListener("keydown", onKey);
    }
  }, [openedTopicId, setOpenedTopicId]);

  if (!openedRoomId || !openedTopicId) return null;

  const sc = topicStatus ? topicStatusColors[topicStatus] : null;
  const statusLabel = topicStatus
    ? ({ open: t.open, completed: t.completed, failed: t.failed, expired: t.expired } as Record<string, string>)[topicStatus] || topicStatus
    : null;

  return (
    <>
      <div
        onClick={() => setOpenedTopicId(null)}
        className="fixed inset-0 z-30 bg-black/40 backdrop-blur-sm md:hidden"
      />
      <aside className="fixed right-0 top-0 z-40 flex h-full w-full flex-col border-l border-glass-border bg-deep-black shadow-2xl">
        <header className="flex items-start gap-2 border-b border-glass-border/60 px-4 py-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-xs uppercase tracking-wide text-text-secondary/60">{t.topic || "Topic"}</span>
              {sc && statusLabel && (
                <span className={`inline-flex items-center gap-1 rounded border px-1.5 py-px text-[10px] font-medium ${sc.color}`}>
                  <span className="text-[8px]">{sc.icon}</span>
                  {statusLabel}
                </span>
              )}
            </div>
            <h2 className="mt-1 truncate text-base font-medium text-text-primary">{topicName}</h2>
            {topicGoal && (
              <p className="mt-1 truncate text-xs text-neon-purple/80">🎯 {topicGoal}</p>
            )}
          </div>
          <button
            onClick={() => setOpenedTopicId(null)}
            className="rounded-md p-1 text-text-secondary transition-colors hover:bg-glass-bg hover:text-text-primary"
            aria-label="Close topic"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-3 py-3">
          {topicMessages.length === 0 ? (
            <div className="flex h-full items-center justify-center text-sm text-text-secondary">
              {t.noMessages}
            </div>
          ) : (
            topicMessages.map((msg) => (
              <MessageBubble
                key={msg.hub_msg_id}
                message={msg}
                isOwn={msg.sender_id === activeAgentId}
              />
            ))
          )}
          <div ref={bottomRef} />
        </div>

        <div className="border-t border-glass-border/60 px-3 py-3">
          <RoomHumanComposer roomId={openedRoomId} />
        </div>
      </aside>
    </>
  );
}
