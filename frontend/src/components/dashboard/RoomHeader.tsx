/**
 * [INPUT]: 依赖 session/ui/chat store 的当前房间选择、成员关系与公开房间缓存，依赖 SubscriptionBadge/CopyableId 展示元信息
 * [OUTPUT]: 对外提供 RoomHeader 组件，渲染会话顶部标题、成员入口、加入入口与分享动作
 * [POS]: dashboard 消息主视图的头部区域，承接当前房间的关键信息与快捷操作
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import { useLanguage } from "@/lib/i18n";
import { roomList } from "@/lib/i18n/translations/dashboard";
import { useShallow } from "zustand/react/shallow";
import ShareModal from "./ShareModal";
import CopyableId from "@/components/ui/CopyableId";
import { api } from "@/lib/api";
import { useDashboardChatStore } from "@/store/useDashboardChatStore";
import { useDashboardSessionStore } from "@/store/useDashboardSessionStore";
import { useDashboardUIStore } from "@/store/useDashboardUIStore";
import SubscriptionBadge from "./SubscriptionBadge";

export default function RoomHeader() {
  const [showShareModal, setShowShareModal] = useState(false);
  const [joinRequestStatus, setJoinRequestStatus] = useState<"idle" | "sending" | "pending" | "rejected">("idle");
  const locale = useLanguage();
  const t = roomList[locale];
  const sessionMode = useDashboardSessionStore((state) => state.sessionMode);
  const { openedRoomId, rightPanelOpen, toggleRightPanel } = useDashboardUIStore(useShallow((state) => ({
    openedRoomId: state.openedRoomId,
    rightPanelOpen: state.rightPanelOpen,
    toggleRightPanel: state.toggleRightPanel,
  })));
  const { overview, getRoomSummary } = useDashboardChatStore(useShallow((state) => ({
    overview: state.overview,
    getRoomSummary: state.getRoomSummary,
  })));
  const { joinRoom, joiningRoomId } = useDashboardChatStore(useShallow((state) => ({
    joinRoom: state.joinRoom,
    joiningRoomId: state.joiningRoomId,
  })));
  const authRoom = overview?.rooms.find((r) => r.room_id === openedRoomId);
  const room = openedRoomId ? getRoomSummary(openedRoomId) : null;
  const roomRule = room?.rule?.trim();
  const isGuest = sessionMode === "guest";
  const isAuthedReady = sessionMode === "authed-ready";
  const isJoined = Boolean(authRoom);
  const isJoining = joiningRoomId === room?.room_id;
  const isInviteOnly = room?.join_policy === "invite_only" && !room?.required_subscription_product_id;
  const loginHref = room ? `/login?next=${encodeURIComponent(`/chats/messages/${room.room_id}`)}` : "/login";

  useEffect(() => {
    if (!isAuthedReady || !room?.room_id || isJoined || !isInviteOnly) return;
    setJoinRequestStatus("idle");
    let cancelled = false;
    api.getMyJoinRequest(room.room_id).then((res) => {
      if (cancelled) return;
      if (res.has_request && res.request) {
        if (res.request.status === "pending") setJoinRequestStatus("pending");
        else if (res.request.status === "rejected") setJoinRequestStatus("rejected");
      }
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [isAuthedReady, room?.room_id, isJoined, isInviteOnly]);

  const handleOpenMembersPanel = () => {
    if (!rightPanelOpen) {
      toggleRightPanel();
    }
  };

  const handleJoinOpenRoom = () => {
    if (!room?.room_id) return;
    if (isGuest) {
      if (typeof window !== "undefined") {
        window.location.href = loginHref;
      }
      return;
    }
    if (!isAuthedReady || room.required_subscription_product_id) return;
    void joinRoom(room.room_id);
  };

  const handleRequestJoin = useCallback(async () => {
    if (!room?.room_id || !isAuthedReady) return;
    setJoinRequestStatus("sending");
    try {
      await api.createJoinRequest(room.room_id);
      setJoinRequestStatus("pending");
    } catch {
      setJoinRequestStatus("idle");
    }
  }, [room?.room_id, isAuthedReady]);

  if (!room) return null;

  const renderJoinButton = () => {
    if (isJoined) return null;

    if (room.required_subscription_product_id) {
      return (
        <SubscriptionBadge
          productId={room.required_subscription_product_id}
          roomId={room.room_id}
          variant="button"
          triggerLabel={t.join}
          loginHref={loginHref}
        />
      );
    }

    if (isInviteOnly) {
      if (joinRequestStatus === "pending") {
        return (
          <span className="rounded border border-amber-400/40 bg-amber-400/10 px-3 py-1.5 text-xs font-medium text-amber-400">
            {t.requestPending}
          </span>
        );
      }
      if (joinRequestStatus === "rejected") {
        return (
          <span className="rounded border border-red-400/40 bg-red-400/10 px-3 py-1.5 text-xs font-medium text-red-400">
            {t.requestRejected}
          </span>
        );
      }
      return (
        <button
          onClick={() => void handleRequestJoin()}
          disabled={!isAuthedReady || joinRequestStatus === "sending"}
          className="rounded border border-amber-400/40 bg-amber-400/10 px-3 py-1.5 text-xs font-medium text-amber-400 transition-colors hover:bg-amber-400/15 disabled:cursor-not-allowed disabled:opacity-50"
          title={t.requestToJoin}
        >
          {joinRequestStatus === "sending" ? t.joining : t.requestToJoin}
        </button>
      );
    }

    return (
      <button
        onClick={handleJoinOpenRoom}
        disabled={!isGuest && (!isAuthedReady || isJoining)}
        className="rounded border border-neon-cyan/40 bg-neon-cyan/10 px-3 py-1.5 text-xs font-medium text-neon-cyan transition-colors hover:bg-neon-cyan/15 disabled:cursor-not-allowed disabled:opacity-50"
        title={t.join}
      >
        {isJoining ? t.joining : t.join}
      </button>
    );
  };

  return (
    <>
      <div className="flex min-h-16 items-start justify-between border-b border-glass-border px-4 py-3">
        <div className="min-w-0 py-0.5">
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
        <div className="flex items-center gap-2 self-start py-0.5">
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
          {renderJoinButton()}
          {isGuest && (
            <span className="rounded border border-neon-purple/30 bg-neon-purple/10 px-2 py-0.5 text-[10px] font-medium text-neon-purple">
              {t.guest}
            </span>
          )}
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

      {showShareModal && isAuthedReady && (
        <ShareModal
          roomId={room.room_id}
          roomName={room.name}
          roomVisibility={room.visibility}
          onClose={() => setShowShareModal(false)}
        />
      )}
    </>
  );
}
