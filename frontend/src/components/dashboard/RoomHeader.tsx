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
import { useRouter } from "nextjs-toploader/app";
import { useShallow } from "zustand/react/shallow";
import { ArrowLeft, Bell, Info, Loader2, PanelLeftOpen, Plus, Settings, Share2 } from "lucide-react";
import CopyableId from "@/components/ui/CopyableId";
import { api, humansApi } from "@/lib/api";
import { useDashboardChatStore } from "@/store/useDashboardChatStore";
import { useDashboardSessionStore } from "@/store/useDashboardSessionStore";
import { useDashboardUIStore } from "@/store/useDashboardUIStore";
import SubscriptionBadge from "./SubscriptionBadge";
import ShareModal from "./ShareModal";
import RoomSettingsModal from "./RoomSettingsModal";
import DMSettingsModal from "./DMSettingsModal";
import RoomPolicyModal from "./RoomPolicyModal";
import AddRoomMemberModal from "./AddRoomMemberModal";
import { dmPeerId, resolveDmDisplayName } from "./dmRoom";

export default function RoomHeader() {
  const [joinRequestStatus, setJoinRequestStatus] = useState<"idle" | "sending" | "pending" | "rejected">("idle");
  const [showRulePopover, setShowRulePopover] = useState(false);
  const [showShareModal, setShowShareModal] = useState(false);
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [showPolicyModal, setShowPolicyModal] = useState(false);
  const [showAddMemberModal, setShowAddMemberModal] = useState(false);
  const [addMemberExistingIds, setAddMemberExistingIds] = useState<string[]>([]);
  const [addMemberLoading, setAddMemberLoading] = useState(false);
  const [humanJoining, setHumanJoining] = useState(false);
  const rulePopoverRef = useRef<HTMLDivElement>(null);
  const locale = useLanguage();
  const router = useRouter();
  const t = roomList[locale];
  const tc = common[locale];
  const [ruleExpanded, setRuleExpanded] = useState(false);
  const [ruleOverflowing, setRuleOverflowing] = useState(false);
  const ruleRef = useRef<HTMLParagraphElement | null>(null);
  const sessionMode = useDashboardSessionStore((state) => state.sessionMode);
  const activeAgentId = useDashboardSessionStore((state) => state.activeAgentId);
  const activeIdentity = useDashboardSessionStore((state) => state.activeIdentity);
  const viewMode = useDashboardSessionStore((state) => state.viewMode);
  const humanRooms = useDashboardSessionStore((state) => state.humanRooms);
  const humanId = useDashboardSessionStore((state) => state.human?.human_id ?? null);
  const refreshHumanRooms = useDashboardSessionStore((state) => state.refreshHumanRooms);
  const { openedRoomId } = useDashboardUIStore(useShallow((state) => ({
    openedRoomId: state.openedRoomId,
  })));
  const { setFocusedRoomId, setOpenedRoomId, setMessagesPane, openMobileSidebar } = useDashboardUIStore(useShallow((state) => ({
    setFocusedRoomId: state.setFocusedRoomId,
    setOpenedRoomId: state.setOpenedRoomId,
    setMessagesPane: state.setMessagesPane,
    openMobileSidebar: state.openMobileSidebar,
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
  const canActAsHuman = !isGuest && Boolean(humanId);
  const canActAsCurrentViewer = isHumanView ? canActAsHuman : isAuthedReady;
  const isJoined = isHumanView ? Boolean(humanRoom) : Boolean(authRoom);
  const isJoining = isHumanView ? humanJoining : joiningRoomId === room?.room_id;
  const isInviteOnly = room?.join_policy === "invite_only" && !room?.required_subscription_product_id;
  const loginHref = room ? `/login?next=${encodeURIComponent(`/chats/messages/${room.room_id}`)}` : "/login";
  const myRole = isHumanView ? humanRoom?.my_role : authRoom?.my_role;
  const isOwnerOrAdmin = myRole === "owner" || myRole === "admin";

  // DM room detection: room_id prefix "rm_dm_"
  const isDMRoom = Boolean(openedRoomId?.startsWith("rm_dm_"));
  // Owner-chat room: deterministic container between a user and their own agent.
  // The user is not stored as a RoomMember (only the agent is), so generic
  // join/invite logic would mistakenly treat the user as an outsider.
  const isOwnerChatRoom = Boolean(openedRoomId?.startsWith("rm_oc_"));
  // Resolve the partner id from rm_dm_{a}_{b} given the current viewer id.
  // Works uniformly for ag_* / hu_* peers — the legacy split("_ag_") code
  // could not handle hu_-prefixed peers.
  const selfId = viewMode === "human" ? humanId : activeAgentId;
  const dmPartnerAgentId = isDMRoom ? dmPeerId(openedRoomId, selfId) : null;
  const isOwnAgentDM = isDMRoom && dmPartnerAgentId === null;
  const dmContact = isDMRoom && dmPartnerAgentId
    ? (overview?.contacts.find((c) => c.contact_agent_id === dmPartnerAgentId) ?? null)
    : null;
  // For DMs, surface the peer's display name instead of the raw "DM ag_X & ag_Y"
  // string the backend stores on Room.name.
  const titleText = isDMRoom && room
    ? resolveDmDisplayName(openedRoomId, selfId, overview?.contacts ?? [], room.name)
    : room?.name ?? "";
  const canInvite = isHumanView
    ? isOwnerOrAdmin || (Boolean(myRole) && Boolean(humanRoom?.default_invite))
    : (authRoom?.can_invite ?? true);
  const canAddMembers = activeIdentity?.type === "human" && isOwnerOrAdmin && isJoined && !isDMRoom && !isOwnerChatRoom;
  const roleLabel = myRole
    ? locale === "zh"
      ? `你是 ${myRole}`
      : `you are ${myRole}`
    : null;

  useEffect(() => {
    if (!canActAsCurrentViewer || !room?.room_id || isJoined || !isInviteOnly) return;
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
  }, [canActAsCurrentViewer, room?.room_id, isJoined, isInviteOnly]);

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

  const handleJoinOpenRoom = () => {
    if (!room?.room_id) return;
    if (isGuest) {
      if (typeof window !== "undefined") {
        window.location.href = loginHref;
      }
      return;
    }
    if (room.required_subscription_product_id) return;
    if (isHumanView) {
      if (!canActAsHuman) return;
      if (humanJoining) return;
      setHumanJoining(true);
      humansApi
        .joinRoom(room.room_id)
        .then(() => refreshHumanRooms())
        .catch(() => {})
        .finally(() => setHumanJoining(false));
      return;
    }
    if (!isAuthedReady) return;
    void joinRoom(room.room_id);
  };

  const handleRequestJoin = useCallback(async () => {
    if (!room?.room_id || !canActAsCurrentViewer) return;
    setJoinRequestStatus("sending");
    try {
      await api.createJoinRequest(room.room_id);
      setJoinRequestStatus("pending");
    } catch {
      setJoinRequestStatus("idle");
    }
  }, [room?.room_id, canActAsCurrentViewer]);

  const handleOpenAddMemberModal = useCallback(async () => {
    if (!room?.room_id || addMemberLoading) return;
    setAddMemberLoading(true);
    try {
      const result = await api.getRoomMembers(room.room_id).catch(() => api.getPublicRoomMembers(room.room_id));
      setAddMemberExistingIds(result.members.map((member) => member.agent_id));
    } catch {
      setAddMemberExistingIds([humanId, activeAgentId].filter(Boolean) as string[]);
    } finally {
      setAddMemberLoading(false);
      setShowAddMemberModal(true);
    }
  }, [activeAgentId, addMemberLoading, humanId, room?.room_id]);

  if (!room) return null;

  const handleMobileBack = () => {
    setMessagesPane("room");
    setFocusedRoomId(null);
    setOpenedRoomId(null);
    router.push("/chats/messages");
  };

  const renderJoinButton = () => {
    if (isJoined || isOwnerChatRoom) return null;

    if (room.required_subscription_product_id) {
      return (
        <SubscriptionBadge
          productId={room.required_subscription_product_id}
          roomId={room.room_id}
          variant="button"
          triggerLabel={t.join}
          loginHref={loginHref}
          className="shrink-0 whitespace-nowrap"
        />
      );
    }

    if (isInviteOnly) {
      if (joinRequestStatus === "pending") {
        return (
          <span className="shrink-0 whitespace-nowrap rounded border border-amber-400/40 bg-amber-400/10 px-3 py-1.5 text-xs font-medium text-amber-400">
            {t.requestPending}
          </span>
        );
      }
      if (joinRequestStatus === "rejected") {
        return (
          <span className="shrink-0 whitespace-nowrap rounded border border-red-400/40 bg-red-400/10 px-3 py-1.5 text-xs font-medium text-red-400">
            {t.requestRejected}
          </span>
        );
      }
      return (
        <button
          onClick={() => void handleRequestJoin()}
          disabled={!canActAsCurrentViewer || joinRequestStatus === "sending"}
          className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded border border-amber-400/40 bg-amber-400/10 px-3 py-1.5 text-xs font-medium text-amber-400 transition-colors hover:bg-amber-400/15 disabled:cursor-not-allowed disabled:opacity-50"
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
        disabled={!isGuest && (!canActAsCurrentViewer || isJoining)}
        className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded border border-neon-cyan/40 bg-neon-cyan/10 px-3 py-1.5 text-xs font-medium text-neon-cyan transition-colors hover:bg-neon-cyan/15 disabled:cursor-not-allowed disabled:opacity-50"
        title={t.join}
      >
        {isJoining ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
        {isJoining ? t.joining : t.join}
      </button>
    );
  };

  const iconBtn = "inline-flex h-8 w-8 items-center justify-center rounded text-text-secondary transition-colors hover:bg-glass-bg hover:text-text-primary";
  const tooltipCls = "pointer-events-none absolute top-full left-1/2 z-30 mt-1 -translate-x-1/2 whitespace-nowrap rounded border border-glass-border bg-deep-black px-2 py-0.5 text-[10px] text-text-secondary opacity-0 shadow-lg transition-opacity group-hover:opacity-100";

  return (
    <>
      <div className="flex min-h-16 items-center justify-between border-b border-glass-border px-4 py-3 max-md:gap-2 max-md:px-3">
        <button
          type="button"
          onClick={handleMobileBack}
          className="hidden h-9 w-9 shrink-0 items-center justify-center rounded-lg text-text-secondary transition-colors hover:bg-glass-bg hover:text-text-primary max-md:inline-flex"
          aria-label="Back to messages"
          title="Back to messages"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={openMobileSidebar}
          className="hidden h-9 w-9 shrink-0 items-center justify-center rounded-lg text-text-secondary transition-colors hover:bg-glass-bg hover:text-text-primary max-md:inline-flex"
          aria-label="Open message list"
          title="Open message list"
        >
          <PanelLeftOpen className="h-4 w-4" />
        </button>
        <div className="min-w-0 py-0.5">
          <div className="flex items-center gap-2">
            <h3 className="truncate text-sm font-semibold text-text-primary">{titleText}</h3>
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
          <div className="flex min-w-0 items-center gap-1.5 overflow-hidden text-xs text-text-secondary">
            <button
              onClick={() => setShowSettingsModal(true)}
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
        <div className="flex shrink-0 flex-nowrap items-center gap-1.5 self-start py-0.5 max-md:gap-1">

          {renderJoinButton()}
          {isGuest && (
            <span className="shrink-0 whitespace-nowrap rounded border border-neon-purple/30 bg-neon-purple/10 px-2 py-0.5 text-[10px] font-medium text-neon-purple">
              {t.guest}
            </span>
          )}
          {isJoined && !isDMRoom && !isOwnerChatRoom && (
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
          {canAddMembers && (
            <span className="group relative">
              <button
                onClick={() => void handleOpenAddMemberModal()}
                disabled={addMemberLoading}
                className={iconBtn}
                aria-label={locale === "zh" ? "添加房间成员" : "Add members"}
              >
                {addMemberLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
              </button>
              <span className={tooltipCls}>{locale === "zh" ? "添加房间成员" : "Add members"}</span>
            </span>
          )}
          {isAuthedReady && activeAgentId && !isHumanView && isJoined && !isOwnerChatRoom && (
            <span className="group relative">
              <button
                onClick={() => setShowPolicyModal(true)}
                className={iconBtn}
                aria-label="我的回复策略"
              >
                <Bell className="h-4 w-4" />
              </button>
              <span className={tooltipCls}>我的回复策略</span>
            </span>
          )}
          {!isOwnerChatRoom && (
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

      {showSettingsModal && !isDMRoom && (
        <RoomSettingsModal
          roomId={room.room_id}
          // Fall back to "agent" for legacy rooms whose overview row predates
          // the polymorphic owner field. Subscription routes will only enable
          // the receiving-bot dropdown when the explicit ``"human"`` is set.
          roomOwnerType={room.owner_type ?? "agent"}
          viewerMode={viewMode}
          viewerRole={myRole}
          initialName={room.name}
          initialDescription={room.description || ""}
          initialRule={room.rule || ""}
          initialVisibility={room.visibility}
          initialJoinPolicy={room.join_policy}
          initialDefaultSend={room.default_send ?? true}
          initialDefaultInvite={room.default_invite ?? false}
          initialMaxMembers={room.max_members ?? null}
          initialSlowModeSeconds={room.slow_mode_seconds ?? null}
          initialSubscriptionProductId={room.required_subscription_product_id ?? null}
          initialAllowHumanSend={room.allow_human_send !== false}
          onClose={() => setShowSettingsModal(false)}
        />
      )}

      {showPolicyModal && activeAgentId && openedRoomId && (
        <RoomPolicyModal
          agentId={activeAgentId}
          roomId={openedRoomId}
          onClose={() => setShowPolicyModal(false)}
        />
      )}

      {showAddMemberModal && room?.room_id && (
        <AddRoomMemberModal
          roomId={room.room_id}
          existingMemberIds={addMemberExistingIds}
          onClose={() => setShowAddMemberModal(false)}
          onAdded={async () => {
            await Promise.all([
              refreshOverview().catch(() => {}),
              refreshHumanRooms().catch(() => {}),
            ]);
          }}
        />
      )}

    </>
  );
}
