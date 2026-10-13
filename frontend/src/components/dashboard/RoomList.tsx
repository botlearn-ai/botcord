"use client";

/**
 * [INPUT]: 依赖 ui/chat/unread/owner-chat store 的会话状态、缓存消息与后端未读标记，依赖 nextjs-toploader/app 做带进度反馈的路由跳转
 * [OUTPUT]: 对外提供 RoomList 组件，按统一最新消息排序，支持置顶、隐藏与左滑已读操作，渲染消息会话列表项与刷新骨架，并提供受 reduced-motion 约束的未读/引导动效
 * [POS]: dashboard 左侧消息导航区的会话列表渲染器，被 Sidebar 组合使用
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

import EmptyState from "@/components/ui/EmptyState";
import Badge from "@/components/ui/Badge";
import Card from "@/components/ui/Card";
import { useEffect, useMemo, useRef, useState } from "react";
import { useLanguage } from '@/lib/i18n';
import { roomList, messagesGrouping } from '@/lib/i18n/translations/dashboard';
import { useRouter } from "nextjs-toploader/app";
import { useShallow } from "zustand/react/shallow";

import { animateIfMotion, cleanupAnime } from "@/lib/anime";
import UnreadBadge from "@/components/ui/UnreadBadge";
import { ContactInfo, DashboardMessage, DashboardRoom } from "@/lib/types";
import { resolveRoomListPreview } from "@/lib/room-list-preview";
import { api } from "@/lib/api";
import { Pin } from "lucide-react";
import { toast } from "@/components/ui/Toast";
import { EMPTY_CONVERSATION_PREFERENCES, useConversationPreferencesStore } from "@/store/useConversationPreferencesStore";
import SwipeableConversationRow from "./SwipeableConversationRow";
import { excludeSpaceRooms, getIsoTimestampValue, humanRoomToDashboardRoom, isOwnerChatRoom } from "@/store/dashboard-shared";
import { canPrefetchMessagePage } from "@/lib/message-prefetch";
import { useDashboardChatStore } from "@/store/useDashboardChatStore";
import { useDashboardSessionStore } from "@/store/useDashboardSessionStore";
import { useDashboardUIStore } from "@/store/useDashboardUIStore";
import { useDashboardUnreadStore } from "@/store/useDashboardUnreadStore";
import { useOwnerChatStore } from "@/store/useOwnerChatStore";
import SubscriptionBadge from "./SubscriptionBadge";
import { resolveDmDisplayName } from "./dmRoom";
import { CompositeAvatar } from "./CompositeAvatar";
import BotAvatar from "./BotAvatar";
import { RoomRowsSkeleton } from "./DashboardTabSkeleton";

interface RoomListProps {
  rooms?: DashboardRoom[];
  loading?: boolean;
  searchQuery?: string;
  includeUserChat?: boolean;
  roomMeta?: Record<string, string>;
}

const EMPTY_CONTACTS: ContactInfo[] = [];

function latestPreviewMessage(messages: DashboardMessage[] | undefined): DashboardMessage | null {
  return messages?.reduce<DashboardMessage | null>((latest, message) => {
    if (["ack", "result", "error"].includes(message.type)) return latest;
    return !latest || getIsoTimestampValue(message.created_at) > getIsoTimestampValue(latest.created_at) ? message : latest;
  }, null) ?? null;
}

function latestOwnerChatPreviewMessage(messages: ReturnType<typeof useOwnerChatStore.getState>["messages"][number][] | undefined) {
  return messages?.findLast((m) => m.type !== "error" && (m.text.trim() || (m.attachments?.length ?? 0) > 0)) ?? null;
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


export default function RoomList({
  rooms: propsRooms,
  loading = false,
  searchQuery = "",
  includeUserChat = false,
  roomMeta,
}: RoomListProps) {
  const router = useRouter();
  const userChatEntryRef = useRef<HTMLDivElement | null>(null);
  const wasOwnerChatEmptyRef = useRef(false);
  const locale = useLanguage();
  const t = roomList[locale];
  const tGroup = messagesGrouping[locale];
  const { overview, publicAgents } = useDashboardChatStore(useShallow((state) => ({
    overview: state.overview,
    publicAgents: state.publicAgents,
  })));
  const cachedLatestMessages = useDashboardChatStore(useShallow((state) => {
    const latestByRoom: Record<string, DashboardMessage | null> = {};
    for (const [roomId, roomMessages] of Object.entries(state.messages)) {
      latestByRoom[roomId] = latestPreviewMessage(roomMessages);
    }
    return latestByRoom;
  }));
  const { focusedRoomId, messagesPane, userChatAgentId, closeMobileSidebar, setFocusedRoomId, setOpenedRoomId, setMessagesPane, setUserChatAgentId, setUserChatRoomId } = useDashboardUIStore(useShallow((state) => ({
    focusedRoomId: state.focusedRoomId,
    messagesPane: state.messagesPane,
    userChatAgentId: state.userChatAgentId,
    closeMobileSidebar: state.closeMobileSidebar,
    setFocusedRoomId: state.setFocusedRoomId,
    setOpenedRoomId: state.setOpenedRoomId,
    setMessagesPane: state.setMessagesPane,
    setUserChatAgentId: state.setUserChatAgentId,
    setUserChatRoomId: state.setUserChatRoomId,
  })));
  const activeAgentId = useDashboardSessionStore((state) => state.activeAgentId);
  const viewMode = useDashboardSessionStore((state) => state.viewMode);
  const humanRooms = useDashboardSessionStore((state) => state.humanRooms);
  const humanId = useDashboardSessionStore((state) => state.human?.human_id ?? null);
  const ownedAgents = useDashboardSessionStore((state) => state.ownedAgents);
  const ownedAgentIds = useMemo(() => new Set(ownedAgents.map((a) => a.agent_id)), [ownedAgents]);
  const ownedAgentAvatarsById = useMemo(() => {
    const m = new Map<string, string | null | undefined>();
    for (const a of ownedAgents) m.set(a.agent_id, a.avatar_url);
    return m;
  }, [ownedAgents]);
  const peerAgentsById = useMemo(() => {
    const m = new Map<string, { owner_display_name: string | null | undefined; avatar_url: string | null | undefined }>();
    for (const a of publicAgents) m.set(a.agent_id, { owner_display_name: a.owner_display_name, avatar_url: a.avatar_url });
    return m;
  }, [publicAgents]);
  // Reuse `overview` (already subscribed above) to derive contacts. Returning
  // `state.overview?.contacts ?? []` from a fresh selector minted a new `[]`
  // whenever overview is null, breaking Zustand's Object.is check and
  // triggering React error #185 (max update depth).
  const contacts = overview?.contacts ?? EMPTY_CONTACTS;
  const agentContactAvatarsById = useMemo(() => {
    const m = new Map<string, string | null | undefined>();
    for (const c of contacts) {
      if (c.peer_type === "agent" || !c.contact_agent_id.startsWith("hu_")) {
        m.set(c.contact_agent_id, c.avatar_url);
      }
    }
    return m;
  }, [contacts]);
  const { isRoomUnread } = useDashboardUnreadStore(useShallow((state) => ({
    isRoomUnread: state.isRoomUnread,
    seen: state.optimisticSeenRoomIds,
    unread: state.optimisticUnreadRoomIds,
  })));
  const account = humanId ? `human:${humanId}` : activeAgentId ? `agent:${activeAgentId}` : "";
  const preferences = useConversationPreferencesStore((state) => state.accounts[account] ?? EMPTY_CONVERSATION_PREFERENCES);
  const [openActions, setOpenActions] = useState<string | null>(null);
  const [markingRead, setMarkingRead] = useState<string | null>(null);
  useEffect(() => { setOpenActions(null); }, [account]);
  const ownerChatMessages = useOwnerChatStore((state) => state.messages);
  const ownerChatLoading = useOwnerChatStore((state) => state.loading);
  const ownerChatRoomId = useOwnerChatStore((state) => state.roomId);
  const ownerChatLatestMessage = useMemo(
    () => latestOwnerChatPreviewMessage(ownerChatMessages),
    [ownerChatMessages],
  );
  const normalizedSearchQuery = searchQuery.trim().toLowerCase();
  // Agent-centric rooms (overview.rooms) ∪ Human-centric rooms (humanRooms),
  // deduped by room_id. When callers pass propsRooms explicitly we honour
  // that and skip the merge. Human rows coexist in the same list so the
  // Sidebar feels identity-agnostic.
  const rooms = (() => {
    if (propsRooms) return propsRooms;
    // Organization (Team) rooms live in the Team workspace, not here.
    const personal = excludeSpaceRooms(overview?.rooms ?? [], humanRooms);
    const agentRooms = personal.agentRooms;
    if (personal.humanRooms.length === 0) return agentRooms;
    const seen = new Set(agentRooms.map((r) => r.room_id));
    const extras = personal.humanRooms
      .filter((r) => !seen.has(r.room_id))
      .map(humanRoomToDashboardRoom);
    return [...agentRooms, ...extras];
  })();
  const showUserChatEntry = includeUserChat && Boolean(activeAgentId) && (
    !normalizedSearchQuery ||
    [t.userChatTitle, t.userChatPreview, t.userChatTooltip, activeAgentId]
      .join("\n")
      .toLowerCase()
      .includes(normalizedSearchQuery)
  );
  // Only show onboarding state when the owner-chat store has been initialized
  // (roomId is set), to avoid false positives when store is in default empty state.
  const isOwnerChatEmpty = showUserChatEntry && Boolean(ownerChatRoomId) && !ownerChatLoading && ownerChatMessages.length === 0;
  const roomEntries = useMemo(() => rooms.map((room, index) => ({
    room, index,
    preview: resolveRoomListPreview(room, cachedLatestMessages[room.room_id] ?? null,
      room.room_id === ownerChatRoomId ? ownerChatLatestMessage : null, locale),
  })), [rooms, cachedLatestMessages, ownerChatRoomId, ownerChatLatestMessage, locale]);
  const displayEntries = useMemo(() => roomEntries
    .filter(({ room, preview }) => normalizedSearchQuery || preferences.hidden[room.room_id] === undefined
      || preview.timestamp > preferences.hidden[room.room_id])
    .sort((a, b) => Number(preferences.pinned.includes(b.room.room_id)) - Number(preferences.pinned.includes(a.room.room_id))
      || b.preview.timestamp - a.preview.timestamp || a.index - b.index),
  [roomEntries, preferences, normalizedSearchQuery]);
  useEffect(() => {
    for (const { room, preview } of roomEntries) {
      if (preferences.hidden[room.room_id] !== undefined && preview.timestamp > preferences.hidden[room.room_id]) {
        useConversationPreferencesStore.getState().show(account, room.room_id);
      }
    }
  }, [account, roomEntries, preferences.hidden]);
  const markRead = async (room: DashboardRoom) => {
    setMarkingRead(room.room_id);
    try {
      await api.markRoomRead(room.room_id);
      // Do not apply a delayed response to another account's unread state.
      const session = useDashboardSessionStore.getState();
      const currentAccount = session.human?.human_id ? `human:${session.human.human_id}` : session.activeAgentId ? `agent:${session.activeAgentId}` : "";
      if (currentAccount === account) await useDashboardUnreadStore.getState().markRoomSeen(room.room_id, null);
    } catch {
      toast({ title: locale === "zh" ? "标为已读失败，请重试" : "Could not mark as read. Please retry.", tone: "danger" });
    } finally { setMarkingRead(null); }
  };
  useEffect(() => {
    const shouldPulseOnboarding = showUserChatEntry && isOwnerChatEmpty;
    if (!shouldPulseOnboarding) {
      wasOwnerChatEmptyRef.current = false;
      return;
    }
    if (wasOwnerChatEmptyRef.current) return;

    let animation: ReturnType<typeof animateIfMotion> = null;
    const frameId = window.requestAnimationFrame(() => {
      wasOwnerChatEmptyRef.current = true;

      const onboardingRow = userChatEntryRef.current;
      if (!onboardingRow) return;

      animation = animateIfMotion(onboardingRow, {
        scale: [1, 1.012, 1],
        boxShadow: [
          "0 0 0 rgba(34, 211, 238, 0)",
          "0 0 12px rgba(34, 211, 238, 0.32)",
          "0 0 0 rgba(34, 211, 238, 0)",
        ],
        duration: 640,
        ease: "out(3)",
      });
    });

    return () => {
      window.cancelAnimationFrame(frameId);
      cleanupAnime(animation);
    };
  }, [isOwnerChatEmpty, showUserChatEntry]);

  const handleSelect = async (room: DashboardRoom) => {
    useConversationPreferencesStore.getState().show(account, room.room_id);
    if (isOwnerChatRoom(room.room_id)) {
      if (canPrefetchMessagePage(room.room_id)) {
        void useDashboardChatStore.getState().prefetchRoomMessages(room.room_id);
      }
      const agentId = room._originAgent?.agent_id || room.owner_id;
      setUserChatAgentId(agentId || null);
      setMessagesPane("user-chat");
      setUserChatRoomId(room.room_id);
      setFocusedRoomId(null);
      setOpenedRoomId(null);
      closeMobileSidebar();
      router.push("/chats/messages");
      return;
    }

    setMessagesPane("room");
    setFocusedRoomId(room.room_id);
    setOpenedRoomId(room.room_id);
    closeMobileSidebar();
    const chatStore = useDashboardChatStore.getState();
    if (Object.prototype.hasOwnProperty.call(chatStore.messages, room.room_id)) {
      // Keep cached conversation content in place, but make an intentional
      // room switch visibly responsive while its delta check is running.
      void chatStore.pollNewMessages(room.room_id, { showLoading: true });
    } else {
      void chatStore.loadRoomMessages(room.room_id);
    }
    router.push("/chats/messages");
  };

  const prefetchRoom = (room: DashboardRoom) => {
    if (!canPrefetchMessagePage(room.room_id)) return;
    void useDashboardChatStore.getState().prefetchRoomMessages(room.room_id);
  };

  const handleRoomKeyDown = (event: React.KeyboardEvent<HTMLElement>, room: DashboardRoom) => {
    if (event.target !== event.currentTarget) {
      return;
    }
    if (event.key !== "Enter" && event.key !== " ") {
      return;
    }
    event.preventDefault();
    void handleSelect(room);
  };

  const handleSelectUserChat = () => {
    if (!showUserChatEntry) return;
    setMessagesPane("user-chat");
    setUserChatAgentId(null);
    setFocusedRoomId(null);
    setOpenedRoomId(null);
    closeMobileSidebar();
    router.push("/chats/messages");
  };

  const handleUserChatKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.target !== event.currentTarget) {
      return;
    }
    if (event.key !== "Enter" && event.key !== " ") {
      return;
    }
    event.preventDefault();
    handleSelectUserChat();
  };

  if (loading) {
    return <RoomRowsSkeleton rows={6} />;
  }

  return (
    <div className="py-2">
      {showUserChatEntry && (
        <Card variant="interactive" padding="sm"
          ref={userChatEntryRef}
          role="button"
          tabIndex={0}
          aria-label={t.userChatAriaLabel}
          aria-current={messagesPane === "user-chat" ? "page" : undefined}
          title={t.userChatTooltip}
          onClick={handleSelectUserChat}
          onKeyDown={handleUserChatKeyDown}
          className={`relative mx-2 my-1  `}
        >
          <div className="flex items-center gap-3">
            <div className={`relative flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border text-accent-text ${
              isOwnerChatEmpty ? "border-neon-cyan/50 bg-accent-soft" : "border-neon-cyan/30 bg-accent-soft"
            }`}>
              {isOwnerChatEmpty && (
                <div className="absolute inset-0 rounded-xl bg-accent-soft blur-md" />
              )}
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" className="relative h-5 w-5">
                <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 8.25h9m-9 3H12m-9.75 1.51c0 1.6 1.123 2.994 2.707 3.227 1.129.166 2.27.293 3.423.379.35.026.67.21.865.501L12 21l2.755-4.133a1.14 1.14 0 0 1 .865-.501 48.172 48.172 0 0 0 3.423-.379c1.584-.233 2.707-1.626 2.707-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0 0 12 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018Z" />
              </svg>
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-2">
                <span className={`truncate text-sm font-medium flex items-center gap-2 ${messagesPane === "user-chat" ? "text-accent-text" : "text-text-primary"}`}>
                  {t.userChatTitle}
                  <Badge tone="accent" >
                    {t.userChatBadge}
                  </Badge>
                  {isOwnerChatEmpty && (
                    <Badge tone="success" >
                      {t.userChatOnboardingBadge}
                    </Badge>
                  )}
                </span>
              </div>
              <p className={`mt-0.5 truncate text-xs ${isOwnerChatEmpty ? "text-accent-text" : "text-text-secondary"}`}>
                {isOwnerChatEmpty ? t.userChatOnboardingPreview : t.userChatPreview}
              </p>
            </div>
          </div>
        </Card>
      )}
      {displayEntries.length === 0 && !showUserChatEntry && (
        <EmptyState compact bordered title={<>{t.noRooms}</>} />
      )}
      {displayEntries.map(({ room, preview }) => {
        const ownerChatAgentId = isOwnerChatRoom(room.room_id) ? room._originAgent?.agent_id || room.owner_id : null;
        const isSelected = ownerChatAgentId
          ? messagesPane === "user-chat" && ownerChatAgentId === (userChatAgentId || activeAgentId)
          : messagesPane === "room" && focusedRoomId === room.room_id;
        const previewText = preview.text || t.noMessagesYet;
        const previewLine = preview.sender ? `${preview.sender}: ${previewText}` : previewText;
        const metaLine = roomMeta?.[room.room_id] ?? null;
        const messageTime = formatLastMessageTime(preview.at);
        const pinned = preferences.pinned.includes(room.room_id);
        const selfRoomId = viewMode === "human" ? humanId : activeAgentId;
        const displayName = resolveDmDisplayName(
          room.room_id,
          selfRoomId,
          contacts,
          room.name,
          room.members_preview,
          locale,
        );
        const avatarLabel = buildRoomAvatarLabel(displayName);
        const avatarTone = buildAvatarTone(room.room_id);
        const isGroup = (room.member_count ?? 0) > 2;
        const isUnread = isRoomUnread(room.room_id, room.has_unread);
        const unreadCount = isUnread ? Math.max(1, room.unread_count ?? 1) : 0;
        const agentAvatarUrl = room.owner_id
          ? ownedAgentAvatarsById.get(room.owner_id)
            ?? agentContactAvatarsById.get(room.owner_id)
            ?? peerAgentsById.get(room.owner_id)?.avatar_url
            ?? null
          : null;

        return (
          <SwipeableConversationRow key={room.room_id}
            open={openActions === room.room_id}
            onOpenChange={(open) => setOpenActions(open ? room.room_id : null)}
            label={`${locale === "zh" ? "会话操作" : "Conversation actions"}: ${displayName}`}
            actions={account ? [
              { label: pinned ? (locale === "zh" ? "取消置顶" : "Unpin") : (locale === "zh" ? "置顶" : "Pin"),
                className: "bg-surface-sunken text-text-primary", onClick: () => useConversationPreferencesStore.getState().togglePin(account, room.room_id) },
              { label: locale === "zh" ? "标为已读" : "Mark read", className: "bg-accent text-on-accent",
                disabled: !isUnread || markingRead !== null, onClick: () => { void markRead(room); } },
              { label: locale === "zh" ? "不显示" : "Hide", className: "bg-warning-soft text-warning", onClick: () => {
                useConversationPreferencesStore.getState().hide(account, room.room_id, preview.timestamp);
                toast({ title: locale === "zh" ? "已隐藏，有新消息时重新显示" : "Hidden until a new message arrives",
                  action: { label: locale === "zh" ? "撤销" : "Undo", onClick: () => useConversationPreferencesStore.getState().show(account, room.room_id) } });
              } },
            ] : []}>
          <Card variant="interactive" padding="sm"
            data-room-list-row="true"
            role="button"
            tabIndex={0}
            aria-label={`Open room ${displayName}`}
            aria-current={isSelected ? "page" : undefined}
            onClick={() => void handleSelect(room)}
            onMouseEnter={() => prefetchRoom(room)}
            onTouchStart={() => prefetchRoom(room)}
            onFocus={() => prefetchRoom(room)}
            onKeyDown={(event) => handleRoomKeyDown(event, room)}
            className={pinned ? "bg-surface-sunken" : ""}
          >
            <div className="flex items-center gap-3">
              {isGroup && room.members_preview && room.members_preview.length >= 2 ? (
                <CompositeAvatar
                  members={room.members_preview}
                  totalMembers={room.member_count ?? room.members_preview.length}
                />
              ) : !isGroup && room.peer_type === "agent" ? (
                <BotAvatar agentId={room.owner_id} avatarUrl={agentAvatarUrl} size={40} alt={displayName} shape="rounded" />
              ) : (
                <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br ${avatarTone} text-sm font-semibold text-text-primary`}>
                  {avatarLabel}
                </div>
              )}
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className={`min-w-0 truncate text-sm font-medium ${isSelected ? "text-accent-text" : "text-text-primary"}`}>
                      {displayName}
                    </span>
                    {!isGroup && room.peer_type === "agent" ? (
                      (() => {
                        // My own bot? owner_id (peer's agent_id) is in my ownedAgents.
                        const isMyBot = room.owner_id && ownedAgentIds.has(room.owner_id);
                        if (isMyBot) {
                          return (
                            <Badge tone="accent" >
                              My Bot
                            </Badge>
                          );
                        }
                        // Third-party bot — show "<owner> 的 Bot" if we know the owner.
                        const peerAgent = room.owner_id ? peerAgentsById.get(room.owner_id) : null;
                        const ownerName = peerAgent?.owner_display_name;
                        const label = ownerName ? tGroup.ownedBotOf(ownerName) : tGroup.externalBot;
                        return (
                          <Badge tone="neutral" >
                            {label}
                          </Badge>
                        );
                      })()
                    ) : !isGroup && room.peer_type === "human" ? (
                      <Badge tone="neutral" >
                        HUMAN
                      </Badge>
                    ) : null}
                  </span>
                  <div className="flex shrink-0 items-center gap-2">
                    {pinned && <Pin size={12} aria-label={locale === "zh" ? "已置顶" : "Pinned"} className="text-accent-text" />}
                    {unreadCount > 0 && (
                      <UnreadBadge count={unreadCount} />
                    )}
                    {messageTime && (
                      <span className="text-xs text-text-secondary">
                        {messageTime}
                      </span>
                    )}
                  </div>
                </div>
                <div className="mt-0.5 flex items-center gap-1.5">
                  {room.required_subscription_product_id && (
                    <span className="shrink-0">
                      <SubscriptionBadge productId={room.required_subscription_product_id} roomId={room.room_id} />
                    </span>
                  )}
                  <p className="min-w-0 truncate pr-6 text-xs text-text-secondary">
                    {previewLine}
                  </p>
                </div>
                {metaLine && (
                  <p className="mt-1 truncate text-xs text-accent-text">
                    {metaLine}
                  </p>
                )}
              </div>
            </div>
          </Card>
          </SwipeableConversationRow>
        );
      })}
    </div>
  );
}
