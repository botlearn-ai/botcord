/**
 * [INPUT]: 依赖 ui/chat store 的公开房间列表与路由导航动作，依赖 SubscriptionBadge 呈现付费房间标记
 * [OUTPUT]: 对外提供 PublicRoomList 组件，渲染游客可浏览的公开房间列表
 * [POS]: dashboard 左侧公开房间列表视图，被游客模式与 explore 相关入口复用
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */
"use client";

import EmptyState from "@/components/ui/EmptyState";
import Button from "@/components/ui/Button";
import { useLanguage } from '@/lib/i18n';
import { roomList } from '@/lib/i18n/translations/dashboard';
import { common } from '@/lib/i18n/translations/common';
import { useRouter } from "nextjs-toploader/app";
import { useShallow } from "zustand/react/shallow";
import { useDashboardChatStore } from "@/store/useDashboardChatStore";
import { useDashboardUIStore } from "@/store/useDashboardUIStore";
import { BotCordLoadingBlock } from "@/components/ui/BotCordLoader";
import SubscriptionBadge from "./SubscriptionBadge";

export default function PublicRoomList() {
  const router = useRouter();
  const locale = useLanguage();
  const t = roomList[locale];
  const tc = common[locale];
  const {
    publicRooms,
    publicRoomsLoading,
    loadPublicRooms,
    addRecentPublicRoom,
  } = useDashboardChatStore(useShallow((state) => ({
    publicRooms: state.publicRooms,
    publicRoomsLoading: state.publicRoomsLoading,
    loadPublicRooms: state.loadPublicRooms,
    addRecentPublicRoom: state.addRecentPublicRoom,
  })));
  const {
    focusedRoomId,
    setFocusedRoomId,
    setOpenedRoomId,
    setMessagesPane,
    startPrimaryNavigation,
  } = useDashboardUIStore(
    useShallow((state) => ({
      focusedRoomId: state.focusedRoomId,
      setFocusedRoomId: state.setFocusedRoomId,
      setOpenedRoomId: state.setOpenedRoomId,
      setMessagesPane: state.setMessagesPane,
      startPrimaryNavigation: state.startPrimaryNavigation,
    })),
  );

  if (publicRoomsLoading && publicRooms.length === 0) {
    return (
      <BotCordLoadingBlock
        label={t.loadingRooms}
        className="p-4"
      />
    );
  }

  if (publicRooms.length === 0) {
    return (
      <EmptyState compact bordered title={<>{t.noPublicRooms}</>} />
    );
  }

  const handleSelect = (roomId: string) => {
    const room = publicRooms.find((item) => item.room_id === roomId);
    const path = "/chats/messages";
    setMessagesPane("room");
    setFocusedRoomId(roomId);
    setOpenedRoomId(roomId);
    startPrimaryNavigation("messages", path);
    if (room) {
      addRecentPublicRoom(room);
    }
    router.push(path);
  };

  return (
    <div className="py-1">
      {publicRooms.map((room) => {
        const isSelected = focusedRoomId === room.room_id;
        return (
          <Button variant="row" aria-pressed={isSelected}
            key={room.room_id}
            onClick={() => handleSelect(room.room_id)}
            className={`w-full `}
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5 min-w-0">
                <span className={`truncate text-sm font-medium ${isSelected ? "text-accent-text" : "text-text-primary"}`}>
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
            <p className="mt-0.5 truncate font-mono text-xs text-text-secondary">
              {room.room_id}
            </p>
            {room.description && (
              <p className="mt-0.5 truncate text-xs text-text-secondary">
                {room.description}
              </p>
            )}
            {room.last_message_preview && (
              <p className="mt-0.5 truncate text-xs text-text-secondary">
                {room.last_sender_name && (
                  <span className="text-text-primary/70">{room.last_sender_name}: </span>
                )}
                {room.last_message_preview}
              </p>
            )}
          </Button>
        );
      })}
      <Button variant="secondary" size="sm"
        onClick={() => void loadPublicRooms()}
        className="mx-3 mb-1 w-[calc(100%-1.5rem)]"
      >
        {tc.refresh}
      </Button>
    </div>
  );
}
