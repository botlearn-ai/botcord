"use client";

import { useEffect, useRef, useCallback, useMemo, useState } from "react";
import { useDashboard } from "./DashboardApp";
import MessageBubble from "./MessageBubble";
import type { DashboardMessage, TopicInfo } from "@/lib/types";

const topicStatusConfig: Record<string, { label: string; color: string; icon: string }> = {
  open:      { label: "Open",      color: "text-neon-cyan bg-neon-cyan/10 border-neon-cyan/30",       icon: "●" },
  completed: { label: "Completed", color: "text-green-400 bg-green-400/10 border-green-400/30",       icon: "✔" },
  failed:    { label: "Failed",    color: "text-red-400 bg-red-400/10 border-red-400/30",             icon: "✗" },
  expired:   { label: "Expired",   color: "text-yellow-400 bg-yellow-400/10 border-yellow-400/30",    icon: "⏱" },
};

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
  const sc = group.topicInfo ? topicStatusConfig[group.topicInfo.status] : null;

  return (
    <button
      onClick={onToggle}
      className="sticky top-0 z-10 flex w-full items-center gap-2 rounded-t-xl bg-deep-black/90 px-3 py-2.5 backdrop-blur-sm transition-colors hover:bg-glass-bg border-b border-glass-border/30"
    >
      <span className="text-xs text-text-secondary/60">{isCollapsed ? "▶" : "▼"}</span>

      <span className="text-sm font-medium text-text-primary truncate">
        {group.topicName || "General"}
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
        {group.messages.length} msg{group.messages.length !== 1 ? "s" : ""}
      </span>
    </button>
  );
}

export default function MessageList() {
  const { state, loadMoreMessages, loadTopics } = useDashboard();
  const containerRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const prevLengthRef = useRef(0);
  const isLoadingMore = useRef(false);
  const [collapsedTopics, setCollapsedTopics] = useState<Set<string>>(new Set());

  const roomId = state.selectedRoomId;
  const messages = roomId ? state.messages[roomId] || [] : [];
  const hasMore = roomId ? state.messagesHasMore[roomId] ?? false : false;
  const currentAgentId = state.overview?.agent.agent_id;
  const topics = roomId ? state.topics[roomId] || [] : [];

  // Load topics when room changes
  useEffect(() => {
    if (roomId) {
      loadTopics(roomId);
      setCollapsedTopics(new Set());
    }
  }, [roomId, loadTopics]);

  const topicsMap = useMemo(() => {
    const m = new Map<string, TopicInfo>();
    for (const t of topics) m.set(t.topic_id, t);
    return m;
  }, [topics]);

  const hasTopics = messages.some((m) => m.topic_id);

  const groups = useMemo(() => {
    if (!hasTopics) return null;
    return groupMessagesByTopic(messages, topicsMap);
  }, [messages, topicsMap, hasTopics]);

  // Scroll to bottom on initial load or new messages appended
  useEffect(() => {
    if (messages.length > prevLengthRef.current && !isLoadingMore.current) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
    prevLengthRef.current = messages.length;
    isLoadingMore.current = false;
  }, [messages.length]);

  // Infinite scroll up
  const handleScroll = useCallback(() => {
    if (!containerRef.current || !roomId || !hasMore || isLoadingMore.current) return;
    if (containerRef.current.scrollTop < 100) {
      isLoadingMore.current = true;
      loadMoreMessages(roomId);
    }
  }, [roomId, hasMore, loadMoreMessages]);

  const toggleTopic = useCallback((topicKey: string) => {
    setCollapsedTopics((prev) => {
      const next = new Set(prev);
      if (next.has(topicKey)) next.delete(topicKey);
      else next.add(topicKey);
      return next;
    });
  }, []);

  if (!roomId) return null;

  if (messages.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-text-secondary">
        No messages yet
      </div>
    );
  }

  // No topics — flat list (original behavior)
  if (!groups) {
    return (
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto px-4 py-3"
      >
        {hasMore && (
          <div className="mb-3 text-center text-xs text-text-secondary animate-pulse">
            Scroll up for older messages...
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
    );
  }

  // Grouped by topic
  return (
    <div
      ref={containerRef}
      onScroll={handleScroll}
      className="flex-1 overflow-y-auto px-4 py-3"
    >
      {hasMore && (
        <div className="mb-3 text-center text-xs text-text-secondary animate-pulse">
          Scroll up for older messages...
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
  );
}
