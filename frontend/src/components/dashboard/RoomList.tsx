"use client";

/**
 * [INPUT]: 依赖 useDashboard 的会话状态与缓存消息，依赖 next/navigation 做路由跳转
 * [OUTPUT]: 对外提供 RoomList 组件，渲染消息会话列表项（头像 + 最后一条消息预览）
 * [POS]: dashboard 左侧消息导航区的会话列表渲染器，被 Sidebar 组合使用
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

import { useDashboard } from "./DashboardApp";
import { useLanguage } from '@/lib/i18n';
import { roomList } from '@/lib/i18n/translations/dashboard';
import { useRouter } from "next/navigation";

import { DashboardRoom } from "@/lib/types";
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
  const { state, loadRoomMessages } = useDashboard();
  const router = useRouter();
  const locale = useLanguage();
  const t = roomList[locale];
  const rooms = propsRooms || state.overview?.rooms || [];

  const handleSelect = (roomId: string) => {
    state.setFocusedRoomId(roomId);
    state.setOpenedRoomId(roomId);
    router.push(`/chats/messages/${encodeURIComponent(roomId)}`);
    if (!state.messages[roomId]) {
      loadRoomMessages(roomId);
    }
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
        const isSelected = state.focusedRoomId === room.room_id;
        const cachedLatestMessage = state.messages[room.room_id]?.[state.messages[room.room_id].length - 1];
        const previewText = room.last_message_preview || cachedLatestMessage?.text || t.noMessagesYet;
        const previewSender = room.last_sender_name || cachedLatestMessage?.sender_name || "";
        const previewLine = previewSender ? `${previewSender}: ${previewText}` : previewText;
        const messageTime = formatLastMessageTime(room.last_message_at);
        const avatarLabel = buildRoomAvatarLabel(room.name);
        const avatarTone = buildAvatarTone(room.room_id);

        return (
          <button
            key={room.room_id}
            onClick={() => handleSelect(room.room_id)}
            className={`w-full border-l-2 px-4 py-3 text-left transition-colors ${
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
                  {messageTime && (
                    <span className="shrink-0 text-[11px] text-text-secondary/80">
                      {messageTime}
                    </span>
                  )}
                </div>
                <p className="mt-0.5 truncate text-xs text-text-secondary">
                  {previewLine}
                </p>
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );
}
