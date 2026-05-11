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
import type { DashboardMessage, PublicRoomMember, TopicInfo } from "@/lib/types";
import type { MentionTextCandidate } from "@/components/ui/MarkdownContent";
import { api } from "@/lib/api";
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
  topicName: string;
  messages: DashboardMessage[];
}

type TimelineItem =
  | { kind: "message"; message: DashboardMessage }
  | { kind: "topic"; group: TopicGroup };

function buildTimelineItems(
  messages: DashboardMessage[],
  topicsMap: Map<string, TopicInfo>,
): TimelineItem[] {
  const groupMap = new Map<string, TopicGroup>();
  const items: TimelineItem[] = [];

  for (const msg of messages) {
    if (!msg.topic_id) {
      items.push({ kind: "message", message: msg });
      continue;
    }

    const existing = groupMap.get(msg.topic_id);
    if (existing) {
      existing.messages.push(msg);
      continue;
    }

    const info = topicsMap.get(msg.topic_id) || null;
    const group: TopicGroup = {
      topicId: msg.topic_id,
      topicInfo: info,
      topicName: info?.title || msg.topic || msg.topic_id,
      messages: [msg],
    };
    groupMap.set(msg.topic_id, group);
    items.push({ kind: "topic", group });
  }

  return items;
}

const TOPIC_PREVIEW_COUNT = 2;

function messagePreviewText(msg: DashboardMessage): string {
  if (msg.text) return msg.text;
  if (typeof msg.payload === "object" && msg.payload && "text" in msg.payload) {
    const text = (msg.payload as { text?: unknown }).text;
    if (typeof text === "string") return text;
  }
  return "";
}

function TopicCard({
  group,
  currentAgentId,
  sourceName,
  sourceId,
  mentionCandidates,
  onOpen,
}: {
  group: TopicGroup;
  currentAgentId: string | undefined;
  sourceName?: string;
  sourceId?: string;
  mentionCandidates?: MentionTextCandidate[];
  onOpen: () => void;
}) {
  const topicStatusConfig = useTopicStatusConfig();
  const locale = useLanguage();
  const t = messageList[locale];
  const sc = group.topicInfo ? topicStatusConfig[group.topicInfo.status] : null;

  const total = group.messages.length;
  const firstMsg = group.messages[0];
  // Show the first message as a full bubble, and up to TOPIC_PREVIEW_COUNT of
  // the most recent messages as compact preview rows (excluding the first).
  const recentPreview = group.messages
    .slice(-TOPIC_PREVIEW_COUNT)
    .filter((m) => !firstMsg || m.hub_msg_id !== firstMsg.hub_msg_id);
  const shownCount = (firstMsg ? 1 : 0) + recentPreview.length;
  const hiddenCount = total - shownCount;

  return (
    <div className="mb-4">
      {/* Topic label row — sits above the first message like a lightweight title */}
      <div className="mb-1 flex items-center gap-2 px-1">
        <span className="text-xs text-neon-cyan/70">💬</span>
        <span className="truncate text-xs font-medium text-text-secondary">
          {group.topicName}
        </span>
        {sc && (
          <span className={`inline-flex items-center gap-1 rounded border px-1.5 py-px text-[10px] font-medium ${sc.color}`}>
            <span className="text-[8px]">{sc.icon}</span>
            {sc.label}
          </span>
        )}
        {group.topicInfo?.goal && (
          <span className="hidden sm:inline-flex items-center gap-1 truncate text-[10px] text-neon-purple/70 max-w-[260px]">
            🎯 {group.topicInfo.goal}
          </span>
        )}
      </div>

      {/* The first message renders as a normal bubble — no outer wrapper. */}
      {firstMsg && (
        <MessageBubble
          message={firstMsg}
          isOwn={firstMsg.sender_id === currentAgentId}
          sourceName={sourceName}
          sourceId={sourceId}
          mentionCandidates={mentionCandidates}
        />
      )}

      {/* Inline thread footer — merged into the same visual layer as the
          message above, like Feishu's "回复话题" row. Clicking opens the drawer. */}
      <div
        role="button"
        tabIndex={0}
        onClick={onOpen}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onOpen();
          }
        }}
        className={`group ml-3 mt-1 cursor-pointer rounded-md px-2 py-1.5 transition-colors hover:bg-glass-bg/60 ${
          firstMsg?.sender_id === currentAgentId ? "mr-3 ml-auto max-w-[70%]" : "max-w-[70%]"
        }`}
      >
        {recentPreview.length > 0 ? (
          <div className="space-y-0.5 border-l-2 border-neon-cyan/30 pl-2">
            {recentPreview.map((msg) => {
              const text = messagePreviewText(msg);
              const isOwn = msg.sender_id === currentAgentId;
              const senderLabel = isOwn
                ? (locale === "zh" ? "你" : "You")
                : (msg.display_sender_name || msg.sender_name || msg.sender_id);
              return (
                <div key={msg.hub_msg_id} className="flex gap-2 text-[11px] leading-tight">
                  <span className="shrink-0 font-medium text-text-secondary/80 max-w-[96px] truncate">
                    {senderLabel}
                  </span>
                  <span className="truncate text-text-primary/70">
                    {text || <em className="text-text-secondary/50">…</em>}
                  </span>
                </div>
              );
            })}
            <div className="flex items-center gap-1 pt-0.5 text-[11px] text-neon-cyan/70 transition-colors group-hover:text-neon-cyan">
              <span>💬</span>
              <span>
                {hiddenCount > 0
                  ? `${hiddenCount} ${t.moreInThread} · ${t.viewThread}`
                  : t.viewThread}
              </span>
              <span>→</span>
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-1 text-[11px] text-neon-cyan/70 transition-colors group-hover:text-neon-cyan">
            <span>💬</span>
            <span>{t.viewThread}</span>
            <span className="text-text-secondary/50">· {total} {total !== 1 ? t.msgs : t.msg}</span>
            <span>→</span>
          </div>
        )}
      </div>
    </div>
  );
}

function isNearBottom(el: HTMLElement, threshold = 150): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
}

export default function MessageList() {
  const locale = useLanguage();
  const t = messageList[locale];
  const { openedRoomId, setOpenedTopicId } = useDashboardUIStore(useShallow((state) => ({
    openedRoomId: state.openedRoomId,
    setOpenedTopicId: state.setOpenedTopicId,
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
  const [showNewMessagesBanner, setShowNewMessagesBanner] = useState(false);
  const [roomMembers, setRoomMembers] = useState<PublicRoomMember[]>([]);
  const showBannerRef = useRef(false);
  const wasNearBottomRef = useRef(true);

  const roomId = openedRoomId;
  const messages = roomId ? messagesByRoom[roomId] || [] : [];
  const roomMemberVersion = useDashboardChatStore(
    (state) => roomId ? (state.roomMemberVersions[roomId] ?? 0) : 0,
  );
  const isRoomMessagesLoading = roomId ? messagesLoading[roomId] ?? false : false;
  const hasMore = roomId ? messagesHasMore[roomId] ?? false : false;
  const currentAgentId = overview?.agent?.agent_id;
  const currentRoomName = overview?.rooms?.find((r) => r.room_id === roomId)?.name ?? roomId ?? "";
  const mentionCandidates = useMemo<MentionTextCandidate[]>(() => {
    const candidates: MentionTextCandidate[] = [];
    const seen = new Set<string>();
    const add = (id: string | null | undefined, label: string | null | undefined) => {
      if (!id || !label || seen.has(id)) return;
      seen.add(id);
      candidates.push({ id, label });
    };

    add("@all", "all");
    for (const member of roomMembers) add(member.agent_id, member.display_name);
    for (const agent of overview?.agent ? [overview.agent] : []) add(agent.agent_id, agent.display_name);
    for (const contact of overview?.contacts ?? []) add(contact.contact_agent_id, contact.alias || contact.display_name);

    return candidates;
  }, [overview?.agent, overview?.contacts, roomMembers]);

  useEffect(() => {
    if (!roomId) {
      setRoomMembers([]);
      return;
    }
    let cancelled = false;
    api.getRoomMembers(roomId)
      .catch(() => api.getPublicRoomMembers(roomId))
      .then((result) => {
        if (!cancelled) setRoomMembers(result.members);
      })
      .catch(() => {
        if (!cancelled) setRoomMembers([]);
      });
    return () => {
      cancelled = true;
    };
  }, [roomId, roomMemberVersion]);

  const commitRoomSeen = useCallback((targetRoomId: string) => {
    const joinedRoom = overview?.rooms.find((room) => room.room_id === targetRoomId);
    if (!joinedRoom) {
      return;
    }
    void markRoomSeen(
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
    setOpenedTopicId(null);
    prevLengthRef.current = 0;
    wasNearBottomRef.current = true;
    setShowNewMessagesBanner(false);
  }, [roomId, setOpenedTopicId]);

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

  const timelineItems = useMemo(() => buildTimelineItems(messages, topicsMap), [messages, topicsMap]);

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
        {timelineItems.map((item) => {
          if (item.kind === "message") {
            const msg = item.message;
            return (
              <MessageBubble
                key={msg.hub_msg_id}
                message={msg}
                isOwn={msg.sender_id === currentAgentId}
                sourceName={currentRoomName}
                sourceId={roomId}
                mentionCandidates={mentionCandidates}
              />
            );
          }

          const { group } = item;
          const key = group.topicId || "__no_topic__";
          return (
            <TopicCard
              key={key}
              group={group}
              currentAgentId={currentAgentId}
              sourceName={currentRoomName}
              sourceId={roomId}
              mentionCandidates={mentionCandidates}
              onOpen={() => group.topicId && setOpenedTopicId(group.topicId)}
            />
          );
        })}
        <div ref={bottomRef} />
      </div>
      {newMessagesBanner}
    </div>
  );
}
