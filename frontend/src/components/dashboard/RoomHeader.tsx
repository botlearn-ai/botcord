/**
 * [INPUT]: 依赖 session/ui/chat store 的当前房间选择、成员关系与公开房间缓存，依赖 SubscriptionBadge/CopyableId 展示元信息
 * [OUTPUT]: 对外提供 RoomHeader 组件，渲染会话顶部标题、规则(Info)、分享、Owner 设置、成员入口与加入入口
 * [POS]: dashboard 消息主视图的头部区域，承接当前房间的关键信息与快捷操作
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */
"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useLanguage } from "@/lib/i18n";
import { common } from "@/lib/i18n/translations/common";
import { roomList } from "@/lib/i18n/translations/dashboard";
import { useShallow } from "zustand/react/shallow";
import { Info, Loader2, Settings, Share2, Users } from "lucide-react";
import CopyableId from "@/components/ui/CopyableId";
import { api, humansApi } from "@/lib/api";
import { useDashboardChatStore } from "@/store/useDashboardChatStore";
import { useDashboardSessionStore } from "@/store/useDashboardSessionStore";
import { useDashboardUIStore } from "@/store/useDashboardUIStore";
import SubscriptionBadge from "./SubscriptionBadge";
import ShareModal from "./ShareModal";
import RoomSettingsModal from "./RoomSettingsModal";
import DMSettingsModal from "./DMSettingsModal";
import RoomMemberSettingsModal from "./RoomMemberSettingsModal";

export default function RoomHeader() {
  const [joinRequestStatus, setJoinRequestStatus] = useState<"idle" | "sending" | "pending" | "rejected">("idle");
  const [showRulePopover, setShowRulePopover] = useState(false);
  const [showShareModal, setShowShareModal] = useState(false);
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [humanJoining, setHumanJoining] = useState(false);
  const rulePopoverRef = useRef<HTMLDivElement>(null);
  const locale = useLanguage();
  const t = roomList[locale];
  const tc = common[locale];
  const [ruleExpanded, setRuleExpanded] = useState(false);
  const [ruleOverflowing, setRuleOverflowing] = useState(false);
  const ruleRef = useRef<HTMLParagraphElement | null>(null);
  const sessionMode = useDashboardSessionStore((state) => state.sessionMode);
  const activeAgentId = useDashboardSessionStore((state) => state.activeAgentId);
  const viewMode = useDashboardSessionStore((state) => state.viewMode);
  const humanRooms = useDashboardSessionStore((state) => state.humanRooms);
  const refreshHumanRooms = useDashboardSessionStore((state) => state.refreshHumanRooms);
  const { openedRoomId, rightPanelOpen, toggleRightPanel } = useDashboardUIStore(useShallow((state) => ({
    openedRoomId: state.openedRoomId,
    rightPanelOpen: state.rightPanelOpen,
    toggleRightPanel: state.toggleRightPanel,
  })));
  const { overview, getRoomSummary, refreshOverview } = useDashboardChatStore(useShallow((state) => ({
    overview: state.overview,
    getRoomSummary: state.getRoomSummary,
    refreshOverview: state.refreshOverview,
  })));
  const { joinRoom, joiningRoomId } = useDashboardChatStore(useShallow((state) => ({
    joinRoom: state.joinRoom,
    joiningRoomId: state.joiningRoomId,
  })));
  const authRoom = overview?.rooms.find((r) => r.room_id === openedRoomId);
  const humanRoom = humanRooms.find((r) => r.room_id === openedRoomId);
  const room = openedRoomId ? getRoomSummary(openedRoomId) : null;
  const roomRule = room?.rule?.trim();
  const roomDescription = room?.description?.trim();
  const hasInfo = Boolean(roomRule || roomDescription);
  const isGuest = sessionMode === "guest";
  const isAuthedReady = sessionMode === "authed-ready";
  const isHumanView = viewMode === "human";
  const isJoined = isHumanView ? Boolean(humanRoom) : Boolean(authRoom);
  const isJoining = isHumanView ? humanJoining : joiningRoomId === room?.room_id;
  const isInviteOnly = room?.join_policy === "invite_only" && !room?.required_subscription_product_id;
  const loginHref = room ? `/login?next=${encodeURIComponent(`/chats/messages/${room.room_id}`)}` : "/login";
  const myRole = isHumanView ? humanRoom?.my_role : authRoom?.my_role;
  const isOwnerOrAdmin = myRole === "owner" || myRole === "admin";

  // DM room detection: room_id prefix "rm_dm_"
  const isDMRoom = Boolean(openedRoomId?.startsWith("rm_dm_"));
  // For DM rooms, figure out the partner agent by filtering activeAgentId from the room ID parts
  const dmPartnerAgentId = isDMRoom && openedRoomId && activeAgentId
    ? openedRoomId.replace("rm_dm_", "").split("_ag_")
        .map((p) => (p ? "ag_" + p : "")).find((id) => id && id !== activeAgentId) ?? null
    : null;
  const isOwnAgentDM = isDMRoom && dmPartnerAgentId === null;
  const dmContact = isDMRoom && dmPartnerAgentId
    ? (overview?.contacts.find((c) => c.contact_agent_id === dmPartnerAgentId) ?? null)
    : null;
  const canInvite = isHumanView ? isOwnerOrAdmin : (authRoom?.can_invite ?? true);
  const roleLabel = myRole
    ? locale === "zh"
      ? `你是 ${myRole}`
      : `you are ${myRole}`
    : null;

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

  // Close rule popover on outside click
  useEffect(() => {
    if (!showRulePopover) return;
    const onClick = (e: MouseEvent) => {
      if (rulePopoverRef.current && !rulePopoverRef.current.contains(e.target as Node)) {
        setShowRulePopover(false);
      }
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [showRulePopover]);

  useLayoutEffect(() => {
    const el = ruleRef.current;
    if (!el) {
      setRuleOverflowing(false);
      return;
    }
    setRuleOverflowing(el.scrollHeight > el.clientHeight + 1);
  }, [roomRule, ruleExpanded]);

  useEffect(() => {
    setRuleExpanded(false);
  }, [openedRoomId]);

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
    if (isHumanView) {
      if (humanJoining) return;
      setHumanJoining(true);
      humansApi
        .joinRoom(room.room_id)
        .then(() => refreshHumanRooms())
        .catch(() => {})
        .finally(() => setHumanJoining(false));
      return;
    }
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

  const iconBtn = "rounded p-1.5 text-text-secondary transition-colors hover:bg-glass-bg hover:text-text-primary";
  const tooltipCls = "pointer-events-none absolute top-full left-1/2 z-30 mt-1 -translate-x-1/2 whitespace-nowrap rounded border border-glass-border bg-deep-black px-2 py-0.5 text-[10px] text-text-secondary opacity-0 shadow-lg transition-opacity group-hover:opacity-100";

  return (
    <>
      <div className="flex min-h-16 items-center justify-between border-b border-glass-border px-4 py-3">
        <div className="min-w-0 py-0.5">
          <div className="flex items-center gap-2">
            <h3 className="truncate text-sm font-semibold text-text-primary">{room.name}</h3>
            {room.required_subscription_product_id ? (
              <SubscriptionBadge productId={room.required_subscription_product_id} roomId={room.room_id} />
            ) : null}
            {hasInfo && (
              <div className="relative" ref={rulePopoverRef}>
                <button
                  onClick={() => setShowRulePopover((v) => !v)}
                  className={`${iconBtn} text-neon-cyan`}
                  title={t.viewRoomInfo}
                  aria-label={t.viewRoomInfo}
                >
                  <Info className="h-4 w-4" />
                </button>
                {showRulePopover && (
                  <div className="absolute left-0 top-full z-30 mt-1 w-[min(32rem,calc(100vw-2rem))] space-y-3 rounded-lg border border-glass-border bg-deep-black p-3 shadow-xl">
                    {roomDescription && (
                      <div>
                        <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-neon-cyan">
                          {t.roomDescriptionLabel}
                        </p>
                        <p className="max-h-48 overflow-y-auto whitespace-pre-wrap text-xs leading-5 text-text-secondary">
                          {roomDescription}
                        </p>
                      </div>
                    )}
                    {roomRule && (
                      <div>
                        <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-neon-cyan">
                          {t.viewRule}
                        </p>
                        <p className="max-h-48 overflow-y-auto whitespace-pre-wrap text-xs leading-5 text-text-secondary">
                          {roomRule}
                        </p>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
          <div className="flex items-center gap-1.5 text-xs text-text-secondary">
            <button
              onClick={handleOpenMembersPanel}
              className="shrink-0 whitespace-nowrap hover:text-neon-cyan hover:underline transition-colors"
            >
              {room.member_count} {room.member_count !== 1 ? t.members : t.member}
            </button>
            {roleLabel && (
              <>
                <span className="shrink-0 text-text-secondary/40">·</span>
                <span className="shrink-0 whitespace-nowrap text-text-secondary/80">{roleLabel}</span>
              </>
            )}
            <span className="shrink-0 text-text-secondary/40">·</span>
            <span className="shrink-0"><CopyableId value={room.room_id} /></span>
          </div>
          {roomRule && (
            <div className="mt-1">
              <p
                ref={ruleRef}
                className={`text-xs leading-5 text-text-secondary ${ruleExpanded ? "" : "line-clamp-2"}`}
              >
                <span className="font-medium text-neon-cyan">{t.rule}</span> {roomRule}
              </p>
              {(ruleOverflowing || ruleExpanded) && (
                <button
                  type="button"
                  onClick={() => setRuleExpanded((v) => !v)}
                  className="mt-0.5 text-[10px] font-medium text-neon-cyan/80 transition-colors hover:text-neon-cyan"
                >
                  {ruleExpanded ? tc.showLess : tc.showMore}
                </button>
              )}
            </div>
          )}
        </div>
        <div className="flex items-center gap-1.5 self-start py-0.5">
          {isAuthedReady && isJoined && myRole && (
            <span className="group relative">
              <span className="rounded border border-glass-border px-2 py-0.5 font-mono text-[10px] text-text-secondary">
                {myRole}
              </span>
              {roleLabel && <span className={tooltipCls}>{roleLabel}</span>}
            </span>
          )}
          {renderJoinButton()}
          {isGuest && (
            <span className="rounded border border-neon-purple/30 bg-neon-purple/10 px-2 py-0.5 text-[10px] font-medium text-neon-purple">
              {t.guest}
            </span>
          )}
          {isJoined && !isDMRoom && (
            <span className="group relative">
              <button
                onClick={() => setShowShareModal(true)}
                className={iconBtn}
                aria-label={t.shareRoom}
              >
                <Share2 className="h-4 w-4" />
              </button>
              <span className={tooltipCls}>{t.shareRoom}</span>
            </span>
          )}
          {isAuthedReady && (isJoined || isDMRoom) && (
            <span className="group relative">
              <button
                onClick={() => setShowSettingsModal(true)}
                className={iconBtn}
                aria-label={t.roomSettings}
              >
                <Settings className="h-4 w-4" />
              </button>
              <span className={tooltipCls}>{t.roomSettings}</span>
            </span>
          )}
          {!isDMRoom && (
            <span className="group relative">
              <button
                onClick={handleOpenMembersPanel}
                className={iconBtn}
                aria-label={t.viewMembers}
              >
                <Users className="h-4 w-4" />
              </button>
              <span className={tooltipCls}>{t.viewMembers}</span>
            </span>
          )}
        </div>
      </div>

      {showShareModal && (
        <ShareModal
          roomId={room.room_id}
          roomName={room.name}
          roomVisibility={room.visibility}
          canInvite={canInvite}
          onClose={() => setShowShareModal(false)}
        />
      )}

      {showSettingsModal && isDMRoom && (
        <DMSettingsModal
          contact={dmContact}
          ownAgentName={overview?.agent?.display_name}
          ownAgentId={activeAgentId ?? undefined}
          onClose={() => setShowSettingsModal(false)}
          onContactRemoved={() => void refreshOverview()}
        />
      )}

      {showSettingsModal && !isDMRoom && isOwnerOrAdmin && (
        <RoomSettingsModal
          roomId={room.room_id}
          initialName={room.name}
          initialDescription={room.description || ""}
          initialRule={room.rule || ""}
          initialVisibility={room.visibility}
          initialJoinPolicy={room.join_policy}
          initialSubscriptionProductId={room.required_subscription_product_id ?? null}
          initialAllowHumanSend={authRoom?.allow_human_send !== false}
          isOwner={authRoom?.my_role === "owner"}
          onClose={() => setShowSettingsModal(false)}
        />
      )}

      {showSettingsModal && !isDMRoom && !isOwnerOrAdmin && myRole && (
        <RoomMemberSettingsModal
          roomId={room.room_id}
          roomName={room.name}
          roomDescription={room.description}
          roomRule={room.rule}
          myRole={myRole}
          requiredSubscriptionProductId={room.required_subscription_product_id}
          onClose={() => setShowSettingsModal(false)}
        />
      )}

    </>
  );
}
