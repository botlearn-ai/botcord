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

import { DashboardRoom } from "@/lib/types";
import { useDashboardChatStore } from "@/store/useDashboardChatStore";
import { useDashboardUIStore } from "@/store/useDashboardUIStore";
import { useDashboardUnreadStore } from "@/store/useDashboardUnreadStore";
import SubscriptionBadge from "./SubscriptionBadge";

interface RoomListProps {
  rooms?: DashboardRoom[];
}

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

export default function RoomList({ rooms: propsRooms }: RoomListProps) {
  const router = useRouter();
  const locale = useLanguage();
  const t = roomList[locale];
  const { overview, messages, loadRoomMessages } = useDashboardChatStore(useShallow((state) => ({
    overview: state.overview,
    messages: state.messages,
    loadRoomMessages: state.loadRoomMessages,
  })));
  const { focusedRoomId, setFocusedRoomId, setOpenedRoomId } = useDashboardUIStore(useShallow((state) => ({
    focusedRoomId: state.focusedRoomId,
    setFocusedRoomId: state.setFocusedRoomId,
    setOpenedRoomId: state.setOpenedRoomId,
  })));
  const isRoomUnread = useDashboardUnreadStore((state) => state.isRoomUnread);
  const rooms = propsRooms || overview?.rooms || [];

  const handleSelect = (roomId: string) => {
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

  if (rooms.length === 0) {
    return (
      <div className="p-4 text-center text-xs text-text-secondary">
        {t.noRooms}
      </div>
    );
  }

  return (
    <div className="py-1">
      {rooms.map((room) => {
        const isSelected = focusedRoomId === room.room_id;
        const roomMessages = messages[room.room_id] || [];
        const cachedLatestMessage = roomMessages[roomMessages.length - 1];
        const previewText = room.last_message_preview || cachedLatestMessage?.text || t.noMessagesYet;
        const previewSender = room.last_sender_name || cachedLatestMessage?.sender_name || "";
        const previewLine = previewSender ? `${previewSender}: ${previewText}` : previewText;
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
                  <span className={`truncate text-sm font-medium flex items-center gap-1.5 ${isSelected ? "text-neon-cyan" : "text-text-primary"}`}>
                    {room.name}
                    {room.required_subscription_product_id && (
                      <SubscriptionBadge productId={room.required_subscription_product_id} roomId={room.room_id} />
                    )}
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
                <p className="mt-0.5 truncate text-xs text-text-secondary">
                  {previewLine}
                </p>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
