"use client";

/**
 * [INPUT]: 依赖 ui/chat/unread store 的会话状态、缓存消息与后端未读标记，依赖 nextjs-toploader/app 做带进度反馈的路由跳转
 * [OUTPUT]: 对外提供 RoomList 组件，渲染消息会话列表项（头像 + 最后一条消息预览 + 未读蓝点）
 * [POS]: dashboard 左侧消息导航区的会话列表渲染器，被 Sidebar 组合使用
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

import { useLanguage } from '@/lib/i18n';
import { roomList } from '@/lib/i18n/translations/dashboard';
import { useRouter } from "nextjs-toploader/app";
import { useShallow } from "zustand/react/shallow";

import { DashboardRoom, HumanRoomSummary } from "@/lib/types";
import { useDashboardChatStore } from "@/store/useDashboardChatStore";
import { useDashboardSessionStore } from "@/store/useDashboardSessionStore";
import { useDashboardUIStore } from "@/store/useDashboardUIStore";
import { useDashboardUnreadStore } from "@/store/useDashboardUnreadStore";
import { useOwnerChatStore } from "@/store/useOwnerChatStore";
import SubscriptionBadge from "./SubscriptionBadge";

/** Fill missing DashboardRoom fields so a Human-owned room renders alongside
 * agent rooms without special-casing the render path. Unread / last-message
 * metadata is not returned by /api/humans/me/rooms yet — zero-fill for now. */
function humanRoomToDashboardRoom(r: HumanRoomSummary): DashboardRoom {
  return {
    room_id: r.room_id,
    name: r.name,
    description: r.description,
    owner_id: r.owner_id,
    visibility: r.visibility,
    join_policy: r.join_policy,
    can_invite: undefined,
    member_count: 0,
    my_role: r.my_role,
    created_at: null,
    rule: null,
    required_subscription_product_id: null,
    last_viewed_at: null,
    has_unread: false,
    last_message_preview: null,
    last_message_at: null,
    last_sender_name: null,
  };
}

interface RoomListProps {
  rooms?: DashboardRoom[];
  loading?: boolean;
  searchQuery?: string;
  includeUserChat?: boolean;
  roomMeta?: Record<string, string>;
}

const USER_CHAT_PATH = "/chats/messages/__user-chat__";

function buildRoomAvatarLabel(roomName: string): string {
  const normalized = roomName.trim();
  if (!normalized) return "?";
  return normalized.slice(0, 1).toUpperCase();
}

function buildAvatarTone(roomId: string): string {
  const tones = [
    "from-sky-500/35 to-cyan-300/35",
    "from-emerald-500/35 to-teal-300/35",
    "from-orange-500/35 to-amber-300/35",
    "from-pink-500/35 to-rose-300/35",
  ];
  const hash = roomId.split("").reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
  return tones[hash % tones.length];
}

function formatLastMessageTime(isoTime: string | null): string {
  if (!isoTime) return "";
  const date = new Date(isoTime);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  return sameDay
    ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleDateString();
}

export default function RoomList({
  rooms: propsRooms,
  loading = false,
  searchQuery = "",
  includeUserChat = true,
  roomMeta,
}: RoomListProps) {
  const router = useRouter();
  const locale = useLanguage();
  const t = roomList[locale];
  const { overview, messages, loadRoomMessages } = useDashboardChatStore(useShallow((state) => ({
    overview: state.overview,
    messages: state.messages,
    loadRoomMessages: state.loadRoomMessages,
  })));
  const { focusedRoomId, messagesPane, setFocusedRoomId, setOpenedRoomId, setMessagesPane } = useDashboardUIStore(useShallow((state) => ({
    focusedRoomId: state.focusedRoomId,
    messagesPane: state.messagesPane,
    setFocusedRoomId: state.setFocusedRoomId,
    setOpenedRoomId: state.setOpenedRoomId,
    setMessagesPane: state.setMessagesPane,
  })));
  const activeAgentId = useDashboardSessionStore((state) => state.activeAgentId);
  const humanRooms = useDashboardSessionStore((state) => state.humanRooms);
  const isRoomUnread = useDashboardUnreadStore((state) => state.isRoomUnread);
  const ownerChatMessages = useOwnerChatStore((state) => state.messages);
  const ownerChatLoading = useOwnerChatStore((state) => state.loading);
  const ownerChatRoomId = useOwnerChatStore((state) => state.roomId);
  const normalizedSearchQuery = searchQuery.trim().toLowerCase();
  // Agent-centric rooms (overview.rooms) ∪ Human-centric rooms (humanRooms),
  // deduped by room_id. When callers pass propsRooms explicitly we honour
  // that and skip the merge. Human rows coexist in the same list so the
  // Sidebar feels identity-agnostic.
  const rooms = (() => {
    if (propsRooms) return propsRooms;
    const agentRooms = overview?.rooms ?? [];
    if (humanRooms.length === 0) return agentRooms;
    const seen = new Set(agentRooms.map((r) => r.room_id));
    const extras = humanRooms
      .filter((r) => !seen.has(r.room_id))
      .map(humanRoomToDashboardRoom);
    return [...agentRooms, ...extras];
  })();
  const showUserChatEntry = includeUserChat && Boolean(activeAgentId) && (
    !normalizedSearchQuery ||
    [t.userChatTitle, t.userChatPreview, t.userChatTooltip, activeAgentId]
      .join("\n")
      .toLowerCase()
      .includes(normalizedSearchQuery)
  );
  // Only show onboarding state when the owner-chat store has been initialized
  // (roomId is set), to avoid false positives when store is in default empty state.
  const isOwnerChatEmpty = showUserChatEntry && Boolean(ownerChatRoomId) && !ownerChatLoading && ownerChatMessages.length === 0;

  const handleSelect = (roomId: string) => {
    setMessagesPane("room");
    setFocusedRoomId(roomId);
    setOpenedRoomId(roomId);
    router.push(`/chats/messages/${encodeURIComponent(roomId)}`);
    if (!messages[roomId]) {
      loadRoomMessages(roomId);
    }
  };

  const handleRoomKeyDown = (event: React.KeyboardEvent<HTMLDivElement>, roomId: string) => {
    if (event.target !== event.currentTarget) {
      return;
    }
    if (event.key !== "Enter" && event.key !== " ") {
      return;
    }
    event.preventDefault();
    handleSelect(roomId);
  };

  const handleSelectUserChat = () => {
    if (!showUserChatEntry) return;
    setMessagesPane("user-chat");
    setFocusedRoomId(null);
    setOpenedRoomId(null);
    router.push(USER_CHAT_PATH);
  };

  const handleUserChatKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) {
      return;
    }
    if (event.key !== "Enter" && event.key !== " ") {
      return;
    }
    event.preventDefault();
    handleSelectUserChat();
  };

  return (
    <div className="py-1">
      {showUserChatEntry && (
        <div
          role="button"
          tabIndex={0}
          aria-label={t.userChatAriaLabel}
          aria-current={messagesPane === "user-chat" ? "page" : undefined}
          title={t.userChatTooltip}
          onClick={handleSelectUserChat}
          onKeyDown={handleUserChatKeyDown}
          className={`relative w-full border-l-2 px-4 py-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neon-cyan/60 ${
            messagesPane === "user-chat"
              ? "border-neon-cyan bg-neon-cyan/10"
              : isOwnerChatEmpty
                ? "border-neon-cyan/50 bg-neon-cyan/[0.06] animate-[pulse-border_2s_ease-in-out_infinite]"
                : "border-transparent hover:bg-glass-bg"
          }`}
        >
          <div className="flex items-center gap-3">
            <div className={`relative flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border text-neon-cyan ${
              isOwnerChatEmpty ? "border-neon-cyan/50 bg-neon-cyan/15" : "border-neon-cyan/30 bg-neon-cyan/10"
            }`}>
              {isOwnerChatEmpty && (
                <div className="absolute inset-0 rounded-xl bg-neon-cyan/20 blur-md animate-pulse" />
              )}
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" className="relative h-5 w-5">
                <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 8.25h9m-9 3H12m-9.75 1.51c0 1.6 1.123 2.994 2.707 3.227 1.129.166 2.27.293 3.423.379.35.026.67.21.865.501L12 21l2.755-4.133a1.14 1.14 0 0 1 .865-.501 48.172 48.172 0 0 0 3.423-.379c1.584-.233 2.707-1.626 2.707-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0 0 12 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018Z" />
              </svg>
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-2">
                <span className={`truncate text-sm font-medium flex items-center gap-2 ${messagesPane === "user-chat" ? "text-neon-cyan" : "text-text-primary"}`}>
                  {t.userChatTitle}
                  <span className="rounded-full border border-neon-cyan/35 bg-neon-cyan/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-neon-cyan">
                    {t.userChatBadge}
                  </span>
                  {isOwnerChatEmpty && (
                    <span className="rounded-full bg-neon-green/20 border border-neon-green/40 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-neon-green animate-pulse">
                      {t.userChatOnboardingBadge}
                    </span>
                  )}
                </span>
              </div>
              <p className={`mt-0.5 truncate text-xs ${isOwnerChatEmpty ? "text-neon-cyan/70" : "text-text-secondary"}`}>
                {isOwnerChatEmpty ? t.userChatOnboardingPreview : t.userChatPreview}
              </p>
            </div>
          </div>
        </div>
      )}
      {loading && (
        <div className="space-y-2 px-3 py-2">
          {Array.from({ length: 6 }).map((_, idx) => (
            <div key={idx} className="rounded-lg border border-glass-border bg-deep-black-light p-3">
              <div className="h-3 w-2/3 animate-pulse rounded bg-glass-border/60" />
              <div className="mt-2 h-2.5 w-1/2 animate-pulse rounded bg-glass-border/50" />
            </div>
          ))}
        </div>
      )}
      {!loading && rooms.length === 0 && !showUserChatEntry && (
        <div className="p-4 text-center text-xs text-text-secondary">
          {t.noRooms}
        </div>
      )}
      {!loading && rooms.map((room) => {
        const isSelected = messagesPane === "room" && focusedRoomId === room.room_id;
        const roomMessages = messages[room.room_id] || [];
        // Find the latest real message (skip ack/result/error receipts)
        const cachedLatestMessage = roomMessages.findLast(
          (m) => m.type !== "ack" && m.type !== "result" && m.type !== "error",
        );
        // Preview text and sender must come from the same source to stay consistent
        let previewText: string;
        let previewSender: string;
        if (room.last_message_preview != null || room.last_sender_name != null) {
          previewText = room.last_message_preview ?? t.noMessagesYet;
          previewSender = room.last_sender_name ?? "";
        } else if (cachedLatestMessage) {
          previewText = cachedLatestMessage.text || t.noMessagesYet;
          previewSender = cachedLatestMessage.sender_name || "";
        } else {
          previewText = t.noMessagesYet;
          previewSender = "";
        }
        const previewLine = previewSender ? `${previewSender}: ${previewText}` : previewText;
        const metaLine = roomMeta?.[room.room_id] ?? null;
        const messageTime = formatLastMessageTime(room.last_message_at);
        const avatarLabel = buildRoomAvatarLabel(room.name);
        const avatarTone = buildAvatarTone(room.room_id);
        const isUnread = isRoomUnread(room.room_id, room.has_unread);

        return (
          <div
            key={room.room_id}
            role="button"
            tabIndex={0}
            aria-label={`Open room ${room.name}`}
            aria-current={isSelected ? "page" : undefined}
            onClick={() => handleSelect(room.room_id)}
            onKeyDown={(event) => handleRoomKeyDown(event, room.room_id)}
            className={`w-full border-l-2 px-4 py-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neon-cyan/60 ${
              isSelected
                ? "border-neon-cyan bg-neon-cyan/10"
                : "border-transparent hover:bg-glass-bg"
            }`}
          >
            <div className="flex items-center gap-3">
              <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br ${avatarTone} text-sm font-semibold text-text-primary`}>
                {avatarLabel}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <span className={`min-w-0 truncate text-sm font-medium ${isSelected ? "text-neon-cyan" : "text-text-primary"}`}>
                    {room.name}
                  </span>
                  <div className="flex shrink-0 items-center gap-2">
                    {isUnread && (
                      <span className="h-2.5 w-2.5 rounded-full bg-neon-cyan shadow-[0_0_10px_rgba(34,211,238,0.6)]" />
                    )}
                    {messageTime && (
                      <span className="text-[11px] text-text-secondary/80">
                        {messageTime}
                      </span>
                    )}
                  </div>
                </div>
                <div className="mt-0.5 flex items-center gap-1.5">
                  {room.required_subscription_product_id && (
                    <span className="shrink-0">
                      <SubscriptionBadge productId={room.required_subscription_product_id} roomId={room.room_id} />
                    </span>
                  )}
                  <p className="min-w-0 truncate text-xs text-text-secondary">
                    {previewLine}
                  </p>
                </div>
                {metaLine && (
                  <p className="mt-1 truncate text-[10px] text-neon-cyan/70">
                    {metaLine}
                  </p>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
