/**
 * [INPUT]: 依赖 chat store 的 discover 房间集合与加入动作，依赖 SubscriptionBadge 提供付费订阅入口
 * [OUTPUT]: 对外提供 DiscoverRoomList 组件，渲染可发现房间及其加入操作
 * [POS]: dashboard explore 房间列表，被登录态 discover 视图消费
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */
"use client";

import { useEffect } from "react";
import { useLanguage } from '@/lib/i18n';
import { roomList } from '@/lib/i18n/translations/dashboard';
import { common } from '@/lib/i18n/translations/common';
import { useShallow } from "zustand/react/shallow";
import { useDashboardChatStore } from "@/store/useDashboardChatStore";
import SubscriptionBadge from "./SubscriptionBadge";

export default function DiscoverRoomList() {
  const locale = useLanguage();
  const t = roomList[locale];
  const tc = common[locale];
  const { discoverRooms, discoverLoading, joiningRoomId, loadDiscoverRooms, joinRoom } = useDashboardChatStore(
    useShallow((state) => ({
      discoverRooms: state.discoverRooms,
      discoverLoading: state.discoverLoading,
      joiningRoomId: state.joiningRoomId,
      loadDiscoverRooms: state.loadDiscoverRooms,
      joinRoom: state.joinRoom,
    })),
  );

  useEffect(() => {
    if (discoverRooms.length === 0 && !discoverLoading) {
      void loadDiscoverRooms();
    }
  }, [discoverRooms.length, discoverLoading, loadDiscoverRooms]);

  if (discoverLoading) {
    return (
      <div className="p-4 text-center text-xs text-text-secondary animate-pulse">
        {t.loadingRooms}
      </div>
    );
  }

  if (discoverRooms.length === 0) {
    return (
      <div className="p-4 text-center text-xs text-text-secondary">
        {t.noRoomsToDiscover}
      </div>
    );
  }

  return (
    <div className="py-1">
      {discoverRooms.map((room) => {
        const isJoining = joiningRoomId === room.room_id;
        return (
          <div
            key={room.room_id}
            className="border-l-2 border-transparent px-4 py-2.5 hover:bg-glass-bg"
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5 min-w-0">
                <span className="truncate text-sm font-medium text-text-primary">
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
            {room.description && (
              <p className="mt-0.5 truncate text-xs text-text-secondary">
                {room.description}
              </p>
            )}
            {room.rule && (
              <p className="mt-0.5 truncate text-xs text-text-secondary/80">
                <span className="text-text-secondary/60">{t.rule}</span>
                {room.rule}
              </p>
            )}
            <button
              onClick={() => void joinRoom(room.room_id)}
              disabled={isJoining}
              className="mt-1.5 rounded border border-neon-cyan/40 px-3 py-0.5 text-xs font-medium text-neon-cyan transition-colors hover:bg-neon-cyan/10 disabled:opacity-40"
            >
              {isJoining ? t.joining : t.join}
            </button>
          </div>
        );
      })}
      <button
        onClick={() => void loadDiscoverRooms()}
        className="w-full py-2 text-xs text-text-secondary hover:text-neon-cyan"
      >
        {tc.refresh}
      </button>
    </div>
  );
}
