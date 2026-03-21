"use client";

/**
 * [INPUT]: 依赖 chat/ui/session/unread store 的消息状态与增量加载动作，依赖共享时间工具更新已读水位，依赖 MessageBubble 渲染单条消息，依赖滚动位置判定已读水位
 * [OUTPUT]: 对外提供 MessageList 组件，渲染消息流、话题分组、历史加载与“新消息”提示
 * [POS]: dashboard 聊天正文区的消息阅读器，负责把实时追加消息转成可见阅读状态
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

import { useEffect, useRef, useCallback, useMemo, useState } from "react";
import { useLanguage } from '@/lib/i18n';
import { messageList } from '@/lib/i18n/translations/dashboard';
import { useShallow } from "zustand/react/shallow";
import MessageBubble from "./MessageBubble";
import type { DashboardMessage, TopicInfo } from "@/lib/types";
import { getLatestSeenAtForRoom } from "@/store/dashboard-shared";
import { useDashboardChatStore } from "@/store/useDashboardChatStore";
import { useDashboardUIStore } from "@/store/useDashboardUIStore";
import { useDashboardUnreadStore } from "@/store/useDashboardUnreadStore";

const topicStatusColors: Record<string, { color: string; icon: string }> = {
  open:      { color: "text-neon-cyan bg-neon-cyan/10 border-neon-cyan/30",       icon: "●" },
  completed: { color: "text-green-400 bg-green-400/10 border-green-400/30",       icon: "✔" },
  failed:    { color: "text-red-400 bg-red-400/10 border-red-400/30",             icon: "✗" },
  expired:   { color: "text-yellow-400 bg-yellow-400/10 border-yellow-400/30",    icon: "⏱" },
};

function useTopicStatusConfig() {
  const locale = useLanguage();
  const t = messageList[locale];
  const labels: Record<string, string> = {
    open: t.open,
    completed: t.completed,
    failed: t.failed,
    expired: t.expired,
  };
  const config: Record<string, { label: string; color: string; icon: string }> = {};
  for (const [key, val] of Object.entries(topicStatusColors)) {
    config[key] = { label: labels[key] || key, ...val };
  }
  return config;
}

interface TopicGroup {
  topicId: string | null;
  topicInfo: TopicInfo | null;
  topicName: string | null;
  messages: DashboardMessage[];
}

function groupMessagesByTopic(
  messages: DashboardMessage[],
  topicsMap: Map<string, TopicInfo>,
): TopicGroup[] {
  const groupMap = new Map<string, DashboardMessage[]>();
  const order: string[] = [];

  for (const msg of messages) {
    const key = msg.topic_id || "__no_topic__";
    if (!groupMap.has(key)) {
      groupMap.set(key, []);
      order.push(key);
    }
    groupMap.get(key)!.push(msg);
  }

  return order.map((key) => {
    const msgs = groupMap.get(key)!;
    if (key === "__no_topic__") {
      return { topicId: null, topicInfo: null, topicName: null, messages: msgs };
    }
    const info = topicsMap.get(key) || null;
    const topicName = info?.title || msgs[0]?.topic || key;
    return { topicId: key, topicInfo: info, topicName, messages: msgs };
  });
}

function TopicHeader({ group, isCollapsed, onToggle }: {
  group: TopicGroup;
  isCollapsed: boolean;
  onToggle: () => void;
}) {
  const topicStatusConfig = useTopicStatusConfig();
  const locale = useLanguage();
  const t = messageList[locale];
  const sc = group.topicInfo ? topicStatusConfig[group.topicInfo.status] : null;

  return (
    <button
      onClick={onToggle}
      className="sticky top-0 z-10 flex w-full items-center gap-2 rounded-t-xl bg-deep-black/90 px-3 py-2.5 backdrop-blur-sm transition-colors hover:bg-glass-bg border-b border-glass-border/30"
    >
      <span className="text-xs text-text-secondary/60">{isCollapsed ? "▶" : "▼"}</span>

      <span className="text-sm font-medium text-text-primary truncate">
        {group.topicName || t.general}
      </span>

      {sc && (
        <span className={`inline-flex items-center gap-1 rounded border px-1.5 py-px text-[10px] font-medium ${sc.color}`}>
          <span className="text-[8px]">{sc.icon}</span>
          {sc.label}
        </span>
      )}

      {group.topicInfo?.goal && (
        <span className="hidden sm:inline-flex items-center gap-1 rounded-lg border border-neon-purple/20 bg-neon-purple/5 px-1.5 py-px text-[10px] text-neon-purple/80 truncate max-w-[200px]">
          <span>🎯</span>
          {group.topicInfo.goal}
        </span>
      )}

      <span className="ml-auto text-[10px] text-text-secondary/50">
        {group.messages.length} {group.messages.length !== 1 ? t.msgs : t.msg}
      </span>
    </button>
  );
}

function isNearBottom(el: HTMLElement, threshold = 150): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
}

export default function MessageList() {
  const locale = useLanguage();
  const t = messageList[locale];
  const { openedRoomId } = useDashboardUIStore(useShallow((state) => ({
    openedRoomId: state.openedRoomId,
  })));
  const { messagesByRoom, messagesLoading, messagesHasMore, loadMoreMessages, overview } = useDashboardChatStore(
    useShallow((state) => ({
      messagesByRoom: state.messages,
      messagesLoading: state.messagesLoading,
      messagesHasMore: state.messagesHasMore,
      loadMoreMessages: state.loadMoreMessages,
      overview: state.overview,
    })),
  );
  const { publicRoomDetails, publicRooms, recentVisitedRooms } = useDashboardChatStore(useShallow((state) => ({
    publicRoomDetails: state.publicRoomDetails,
    publicRooms: state.publicRooms,
    recentVisitedRooms: state.recentVisitedRooms,
  })));
  const markRoomSeen = useDashboardUnreadStore((state) => state.markRoomSeen);
  const containerRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const prevLengthRef = useRef(0);
  const isLoadingMore = useRef(false);
  const [collapsedTopics, setCollapsedTopics] = useState<Set<string>>(new Set());
  const [showNewMessagesBanner, setShowNewMessagesBanner] = useState(false);
  const showBannerRef = useRef(false);
  const wasNearBottomRef = useRef(true);

  const roomId = openedRoomId;
  const messages = roomId ? messagesByRoom[roomId] || [] : [];
  const isRoomMessagesLoading = roomId ? messagesLoading[roomId] ?? false : false;
  const hasMore = roomId ? messagesHasMore[roomId] ?? false : false;
  const currentAgentId = overview?.agent?.agent_id;
  const commitRoomSeen = useCallback((targetRoomId: string) => {
    markRoomSeen(
      targetRoomId,
      getLatestSeenAtForRoom(targetRoomId, {
        messages: messagesByRoom,
        overview,
        publicRoomDetails,
        publicRooms,
        recentVisitedRooms,
      }),
    );
  }, [markRoomSeen, messagesByRoom, overview, publicRoomDetails, publicRooms, recentVisitedRooms]);

  useEffect(() => {
    setCollapsedTopics(new Set());
    prevLengthRef.current = 0;
    wasNearBottomRef.current = true;
    setShowNewMessagesBanner(false);
  }, [roomId]);

  const topicsMap = useMemo(() => {
    const m = new Map<string, TopicInfo>();
    const counter = new Map<string, number>();
    for (const msg of messages) {
      if (!msg.topic_id) continue;
      counter.set(msg.topic_id, (counter.get(msg.topic_id) || 0) + 1);
      if (m.has(msg.topic_id)) continue;
      m.set(msg.topic_id, {
        topic_id: msg.topic_id,
        room_id: msg.room_id || roomId || "",
        title: msg.topic_title || msg.topic || msg.topic_id,
        description: msg.topic_description || "",
        status: msg.topic_status || "open",
        creator_id: msg.topic_creator_id || msg.sender_id,
        goal: msg.topic_goal || null,
        message_count: 0,
        created_at: msg.topic_created_at || msg.created_at,
        updated_at: msg.topic_updated_at || msg.created_at,
        closed_at: msg.topic_closed_at || null,
      });
    }
    for (const [topicId, count] of counter.entries()) {
      const topic = m.get(topicId);
      if (topic) topic.message_count = topic.message_count || count;
    }
    return m;
  }, [messages, roomId]);

  const hasTopics = messages.some((m) => m.topic_id);

  const groups = useMemo(() => {
    if (!hasTopics) return null;
    return groupMessagesByTopic(messages, topicsMap);
  }, [messages, topicsMap, hasTopics]);

  // Auto-scroll or show "new messages" banner when new messages arrive.
  // Uses wasNearBottomRef (snapshotted on scroll events, before DOM changes)
  // to decide whether to auto-scroll or show the banner.
  useEffect(() => {
    if (messages.length > prevLengthRef.current && !isLoadingMore.current) {
      if (wasNearBottomRef.current) {
        bottomRef.current?.scrollIntoView({ behavior: "auto" });
        setShowNewMessagesBanner(false);
        if (roomId) {
          commitRoomSeen(roomId);
        }
      } else if (prevLengthRef.current > 0) {
        // User is reading history — show banner instead of auto-scrolling
        setShowNewMessagesBanner(true);
      }
    }
    prevLengthRef.current = messages.length;
    isLoadingMore.current = false;
  }, [messages.length, roomId, commitRoomSeen]);

  // Keep ref in sync with state for use in scroll handler
  useEffect(() => {
    showBannerRef.current = showNewMessagesBanner;
  }, [showNewMessagesBanner]);

  // Track scroll position & handle infinite scroll up
  const handleScroll = useCallback(() => {
    if (!containerRef.current || !roomId) return;

    // Snapshot scroll position for use by the auto-scroll effect
    wasNearBottomRef.current = isNearBottom(containerRef.current);

    // Infinite scroll up
    if (hasMore && !isLoadingMore.current && containerRef.current.scrollTop < 100) {
      isLoadingMore.current = true;
      loadMoreMessages(roomId);
    }

    // Dismiss banner when scrolled near bottom
    if (showBannerRef.current && wasNearBottomRef.current) {
      setShowNewMessagesBanner(false);
    }
    if (wasNearBottomRef.current) {
      commitRoomSeen(roomId);
    }
  }, [roomId, hasMore, loadMoreMessages, commitRoomSeen]);

  // Reset banner on room change
  useEffect(() => {
    setShowNewMessagesBanner(false);
  }, [roomId]);

  const scrollToBottom = useCallback(() => {
    bottomRef.current?.scrollIntoView({ behavior: "auto" });
    setShowNewMessagesBanner(false);
    if (roomId) {
      commitRoomSeen(roomId);
    }
  }, [roomId, commitRoomSeen]);

  const toggleTopic = useCallback((topicKey: string) => {
    setCollapsedTopics((prev) => {
      const next = new Set(prev);
      if (next.has(topicKey)) next.delete(topicKey);
      else next.add(topicKey);
      return next;
    });
  }, []);

  if (!roomId) return null;

  if (isRoomMessagesLoading && messages.length === 0) {
    return (
      <div className="flex-1 overflow-y-auto px-4 py-3">
        <div className="space-y-3">
          {Array.from({ length: 8 }).map((_, idx) => (
            <div
              key={idx}
              className={`h-11 w-full animate-pulse rounded-lg border border-glass-border/60 bg-deep-black-light ${
                idx % 2 === 0 ? "max-w-[72%]" : "ml-auto max-w-[64%]"
              }`}
            />
          ))}
        </div>
      </div>
    );
  }

  if (messages.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-text-secondary">
        {t.noMessages}
      </div>
    );
  }

  const newMessagesBanner = showNewMessagesBanner && (
    <button
      onClick={scrollToBottom}
      className="absolute bottom-4 left-1/2 -translate-x-1/2 z-20 rounded-full bg-neon-cyan/90 px-4 py-1.5 text-xs font-medium text-deep-black shadow-lg shadow-neon-cyan/20 transition-all hover:bg-neon-cyan animate-bounce"
    >
      {t.newMessages}
    </button>
  );

  // No topics — flat list (original behavior)
  if (!groups) {
    return (
      <div className="relative flex-1">
        <div
          ref={containerRef}
          onScroll={handleScroll}
          className="absolute inset-0 overflow-y-auto px-4 py-3"
        >
          {hasMore && (
            <div className="mb-3 text-center text-xs text-text-secondary animate-pulse">
              {t.scrollUp}
            </div>
          )}
          {messages.map((msg) => (
            <MessageBubble
              key={msg.hub_msg_id}
              message={msg}
              isOwn={msg.sender_id === currentAgentId}
            />
          ))}
          <div ref={bottomRef} />
        </div>
        {newMessagesBanner}
      </div>
    );
  }

  // Grouped by topic
  return (
    <div className="relative flex-1">
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="absolute inset-0 overflow-y-auto px-4 py-3"
      >
        {hasMore && (
          <div className="mb-3 text-center text-xs text-text-secondary animate-pulse">
            {t.scrollUp}
          </div>
        )}
        {groups.map((group) => {
          const key = group.topicId || "__no_topic__";
          const isCollapsed = collapsedTopics.has(key);
          const statusColor = group.topicInfo
            ? { completed: "border-green-400/40", failed: "border-red-400/40", expired: "border-yellow-400/40", open: "border-neon-cyan/40" }[group.topicInfo.status] || "border-neon-cyan/40"
            : "border-glass-border";

          return (
            <div key={key} className={`mb-4 rounded-xl border border-glass-border/50 bg-glass-bg/30`}>
              <TopicHeader
                group={group}
                isCollapsed={isCollapsed}
                onToggle={() => toggleTopic(key)}
              />
              {!isCollapsed && (
                <div className={`border-l-2 ${statusColor} ml-3 pl-3 pr-1 pb-2`}>
                  {group.messages.map((msg) => (
                    <MessageBubble
                      key={msg.hub_msg_id}
                      message={msg}
                      isOwn={msg.sender_id === currentAgentId}
                    />
                  ))}
                </div>
              )}
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>
      {newMessagesBanner}
    </div>
  );
}
