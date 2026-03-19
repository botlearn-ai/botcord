/**
 * [INPUT]: 依赖 dashboard store 的当前房间选择、分享状态与公开房间缓存，依赖 SubscriptionBadge/CopyableId 展示元信息
 * [OUTPUT]: 对外提供 RoomHeader 组件，渲染会话顶部标题、成员入口、订阅标记与分享动作
 * [POS]: dashboard 消息主视图的头部区域，承接当前房间的关键信息与快捷操作
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */
"use client";

import { useState } from "react";
import { useDashboard } from "./DashboardApp";
import { useLanguage } from "@/lib/i18n";
import { roomList } from "@/lib/i18n/translations/dashboard";
import ShareModal from "./ShareModal";
import CopyableId from "@/components/ui/CopyableId";
import SubscriptionBadge from "./SubscriptionBadge";

export default function RoomHeader() {
  const { state, isGuest, isAuthedReady } = useDashboard();
  const [showShareModal, setShowShareModal] = useState(false);
  const locale = useLanguage();
  const t = roomList[locale];
  const currentRoomId = state.openedRoomId;
  const authRoom = state.overview?.rooms.find((r) => r.room_id === currentRoomId);
  const room = currentRoomId ? state.getRoomSummary(currentRoomId) : null;
  const roomRule = room?.rule?.trim();

  const handleOpenMembersPanel = () => {
    if (!state.rightPanelOpen) {
      state.toggleRightPanel();
    }
  };

  if (!room) return null;

  return (
    <>
      <div className="flex items-center justify-between border-b border-glass-border px-4 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="truncate text-sm font-semibold text-text-primary">{room.name}</h3>
            {room.required_subscription_product_id ? (
              <SubscriptionBadge productId={room.required_subscription_product_id} roomId={room.room_id} />
            ) : null}
            <CopyableId value={room.room_id} />
          </div>
          <div className="flex items-center text-xs text-text-secondary">
            <button
              onClick={handleOpenMembersPanel}
              className="hover:text-neon-cyan hover:underline transition-colors"
            >
              {room.member_count} {room.member_count !== 1 ? t.members : t.member}
            </button>
            {room.description && <span className="ml-2 text-text-secondary/60">· {room.description}</span>}
          </div>
          {roomRule && (
            <p className="mt-1 text-xs leading-5 text-text-secondary">
              <span className="font-medium text-neon-cyan">{t.rule}</span> {roomRule}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          {isAuthedReady && authRoom && (
            <>
              <span className="rounded border border-glass-border px-2 py-0.5 font-mono text-[10px] text-text-secondary">
                {authRoom.my_role}
              </span>
              <button
                onClick={() => setShowShareModal(true)}
                className="rounded p-1 text-text-secondary hover:bg-glass-bg hover:text-text-primary"
                title={t.shareRoom}
              >
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M4 8V12C4 12.5523 4.44772 13 5 13H11C11.5523 13 12 12.5523 12 12V8" />
                  <path d="M8 3V10" />
                  <path d="M5.5 5.5L8 3L10.5 5.5" />
                </svg>
              </button>
            </>
          )}
          {isGuest && (
            <span className="rounded border border-neon-purple/30 bg-neon-purple/10 px-2 py-0.5 text-[10px] font-medium text-neon-purple">
              {t.guest}
            </span>
          )}
          {/* Members toggle */}
          <button
            onClick={handleOpenMembersPanel}
            className="rounded p-1 text-text-secondary transition-colors hover:bg-glass-bg hover:text-text-primary"
            title={t.viewMembers}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
              <circle cx="6" cy="5" r="2.5" />
              <path d="M1.5 14c0-2.5 2-4.5 4.5-4.5s4.5 2 4.5 4.5" />
              <circle cx="11.5" cy="5.5" r="1.8" />
              <path d="M11.5 9c1.8 0 3.2 1.2 3.5 3" />
            </svg>
          </button>
        </div>
      </div>

      {showShareModal && isAuthedReady && state.token && (
        <ShareModal
          roomId={room.room_id}
          roomName={room.name}
          token={state.token}
          onClose={() => setShowShareModal(false)}
        />
      )}
    </>
  );
}
