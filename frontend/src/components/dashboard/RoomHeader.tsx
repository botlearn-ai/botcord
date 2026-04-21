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
import { Loader2 } from "lucide-react";
import CopyableId from "@/components/ui/CopyableId";
import { api } from "@/lib/api";
import { useDashboardChatStore } from "@/store/useDashboardChatStore";
import { useDashboardSessionStore } from "@/store/useDashboardSessionStore";
import { useDashboardUIStore } from "@/store/useDashboardUIStore";
import SubscriptionBadge from "./SubscriptionBadge";

export default function RoomHeader() {
  const [joinRequestStatus, setJoinRequestStatus] = useState<"idle" | "sending" | "pending" | "rejected">("idle");
  const locale = useLanguage();
  const t = roomList[locale];
  const sessionMode = useDashboardSessionStore((state) => state.sessionMode);
  const { openedRoomId, rightPanelOpen, toggleRightPanel } = useDashboardUIStore(useShallow((state) => ({
    openedRoomId: state.openedRoomId,
    rightPanelOpen: state.rightPanelOpen,
    toggleRightPanel: state.toggleRightPanel,
  })));
  const { overview, getRoomSummary, patchRoom } = useDashboardChatStore(useShallow((state) => ({
    overview: state.overview,
    getRoomSummary: state.getRoomSummary,
    patchRoom: state.patchRoom,
  })));
  const { joinRoom, joiningRoomId } = useDashboardChatStore(useShallow((state) => ({
    joinRoom: state.joinRoom,
    joiningRoomId: state.joiningRoomId,
  })));
  const [humanSendSaving, setHumanSendSaving] = useState(false);
  const [humanSendError, setHumanSendError] = useState<string | null>(null);
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

  const canManageRoom = authRoom?.my_role === "owner" || authRoom?.my_role === "admin";
  const humanSendAllowed = authRoom?.allow_human_send !== false;

  const handleToggleHumanSend = useCallback(async () => {
    if (!authRoom || !canManageRoom || humanSendSaving) return;
    const next = !humanSendAllowed;
    setHumanSendSaving(true);
    setHumanSendError(null);
    try {
      const updated = await api.updateRoom(authRoom.room_id, { allow_human_send: next });
      patchRoom(authRoom.room_id, { allow_human_send: updated.allow_human_send ?? next });
    } catch (err) {
      setHumanSendError(err instanceof Error ? err.message : "Failed to update");
    } finally {
      setHumanSendSaving(false);
    }
  }, [authRoom, canManageRoom, humanSendAllowed, humanSendSaving, patchRoom]);

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
          className="inline-flex items-center gap-1.5 rounded border border-amber-400/40 bg-amber-400/10 px-3 py-1.5 text-xs font-medium text-amber-400 transition-colors hover:bg-amber-400/15 disabled:cursor-not-allowed disabled:opacity-50"
          title={t.requestToJoin}
        >
          {joinRequestStatus === "sending" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          {joinRequestStatus === "sending" ? t.joining : t.requestToJoin}
        </button>
      );
    }

    return (
      <button
        onClick={handleJoinOpenRoom}
        disabled={!isGuest && (!isAuthedReady || isJoining)}
        className="inline-flex items-center gap-1.5 rounded border border-neon-cyan/40 bg-neon-cyan/10 px-3 py-1.5 text-xs font-medium text-neon-cyan transition-colors hover:bg-neon-cyan/15 disabled:cursor-not-allowed disabled:opacity-50"
        title={t.join}
      >
        {isJoining ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
        {isJoining ? t.joining : t.join}
      </button>
    );
  };

  return (
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
          {isAuthedReady && authRoom && canManageRoom && (
            <button
              type="button"
              onClick={() => void handleToggleHumanSend()}
              disabled={humanSendSaving}
              title={humanSendError ?? t.humanSendToggleHint}
              className={`inline-flex items-center gap-1 rounded border px-2 py-0.5 text-[10px] font-medium transition-colors disabled:opacity-50 ${
                humanSendAllowed
                  ? "border-neon-green/40 bg-neon-green/10 text-neon-green hover:bg-neon-green/15"
                  : "border-glass-border bg-glass-bg text-text-secondary hover:border-neon-cyan/40"
              }`}
            >
              {humanSendSaving ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
              {humanSendAllowed ? t.humanSendOn : t.humanSendOff}
            </button>
          )}
          {isAuthedReady && authRoom && (
              <span className="rounded border border-glass-border px-2 py-0.5 font-mono text-[10px] text-text-secondary">
                {authRoom.my_role}
              </span>
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
  );
}
