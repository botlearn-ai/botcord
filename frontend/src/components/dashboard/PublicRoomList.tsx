/**
 * [INPUT]: 依赖 dashboard store 的公开房间列表与消息加载动作，依赖 SubscriptionBadge 呈现付费房间标记
 * [OUTPUT]: 对外提供 PublicRoomList 组件，渲染游客可浏览的公开房间列表
 * [POS]: dashboard 左侧公开房间列表视图，被游客模式与 explore 相关入口复用
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */
"use client";

import { useDashboard } from "./DashboardApp";
import { useLanguage } from '@/lib/i18n';
import { roomList } from '@/lib/i18n/translations/dashboard';
import { common } from '@/lib/i18n/translations/common';
import { useRouter } from "next/navigation";
import SubscriptionBadge from "./SubscriptionBadge";

export default function PublicRoomList() {
  const router = useRouter();
  const { state, loadRoomMessages, loadPublicRooms } = useDashboard();
  const locale = useLanguage();
  const t = roomList[locale];
  const tc = common[locale];

  if (state.publicRoomsLoading) {
    return (
      <div className="p-4 text-center text-xs text-text-secondary animate-pulse">
        {t.loadingRooms}
      </div>
    );
  }

  if (state.publicRooms.length === 0) {
    return (
      <div className="p-4 text-center text-xs text-text-secondary">
        {t.noPublicRooms}
      </div>
    );
  }

  const handleSelect = (roomId: string) => {
    const room = state.publicRooms.find((item) => item.room_id === roomId);
    state.setFocusedRoomId(roomId);
    state.setOpenedRoomId(roomId);
    state.setSidebarTab("messages");
    router.push(`/chats/messages/${encodeURIComponent(roomId)}`);
    if (room) {
      state.addRecentPublicRoom(room);
    }
    if (!state.messages[roomId]) {
      loadRoomMessages(roomId);
    }
  };

  return (
    <div className="py-1">
      {state.publicRooms.map((room) => {
        const isSelected = state.focusedRoomId === room.room_id;
        return (
          <button
            key={room.room_id}
            onClick={() => handleSelect(room.room_id)}
            className={`w-full px-4 py-2.5 text-left transition-colors ${
              isSelected
                ? "bg-neon-cyan/10 border-l-2 border-neon-cyan"
                : "hover:bg-glass-bg border-l-2 border-transparent"
            }`}
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5 min-w-0">
                <span className={`truncate text-sm font-medium ${isSelected ? "text-neon-cyan" : "text-text-primary"}`}>
                  {room.name}
                </span>
                {room.required_subscription_product_id && (
                  <SubscriptionBadge productId={room.required_subscription_product_id} roomId={room.room_id} />
                )}
              </div>
              <span className="ml-2 shrink-0 text-xs text-text-secondary">
                {room.member_count}
              </span>
            </div>
            <p className="mt-0.5 truncate font-mono text-[10px] text-text-secondary/50">
              {room.room_id}
            </p>
            {room.description && (
              <p className="mt-0.5 truncate text-xs text-text-secondary">
                {room.description}
              </p>
            )}
            {room.last_message_preview && (
              <p className="mt-0.5 truncate text-xs text-text-secondary/60">
                {room.last_sender_name && (
                  <span className="text-text-primary/70">{room.last_sender_name}: </span>
                )}
                {room.last_message_preview}
              </p>
            )}
          </button>
        );
      })}
      <button
        onClick={loadPublicRooms}
        className="w-full py-2 text-xs text-text-secondary hover:text-neon-cyan"
      >
        {tc.refresh}
      </button>
    </div>
  );
}
