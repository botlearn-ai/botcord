"use client";

/**
 * [INPUT]: 依赖 ui/chat/unread store 的会话状态、缓存消息与后端未读标记，依赖 nextjs-toploader/app 做带进度反馈的路由跳转
 * [OUTPUT]: 对外提供 RoomList 组件，渲染消息会话列表项与刷新骨架（头像 + 最后一条消息预览 + 未读数量）
 * [POS]: dashboard 左侧消息导航区的会话列表渲染器，被 Sidebar 组合使用
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

import { useMemo } from "react";
import { useLanguage } from '@/lib/i18n';
import { roomList, messagesGrouping } from '@/lib/i18n/translations/dashboard';
import { useRouter } from "nextjs-toploader/app";
import { useShallow } from "zustand/react/shallow";

import { ContactInfo, DashboardMessage, DashboardRoom } from "@/lib/types";
import { humanRoomToDashboardRoom, isOwnerChatRoom } from "@/store/dashboard-shared";
import { useDashboardChatStore } from "@/store/useDashboardChatStore";
import { useDashboardSessionStore } from "@/store/useDashboardSessionStore";
import { useDashboardUIStore } from "@/store/useDashboardUIStore";
import { useDashboardUnreadStore } from "@/store/useDashboardUnreadStore";
import { useOwnerChatStore } from "@/store/useOwnerChatStore";
import SubscriptionBadge from "./SubscriptionBadge";
import { resolveDmDisplayName } from "./dmRoom";
import { CompositeAvatar } from "./CompositeAvatar";
import BotAvatar from "./BotAvatar";
import { SidebarListSkeleton } from "./DashboardTabSkeleton";

interface RoomListProps {
  rooms?: DashboardRoom[];
  loading?: boolean;
  searchQuery?: string;
  includeUserChat?: boolean;
  roomMeta?: Record<string, string>;
}

const EMPTY_CONTACTS: ContactInfo[] = [];

function latestPreviewMessage(messages: DashboardMessage[] | undefined): DashboardMessage | null {
  return messages?.findLast((m) => m.type !== "ack" && m.type !== "result" && m.type !== "error") ?? null;
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

function formatUnreadCount(count: number): string {
  return count > 99 ? "99+" : String(count);
}

export default function RoomList({
  rooms: propsRooms,
  loading = false,
  searchQuery = "",
  includeUserChat = true,
  roomMeta,
}: RoomListProps) {
  const router = useRouter();
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
  const isRoomUnread = useDashboardUnreadStore((state) => state.isRoomUnread);
  const ownerChatMessages = useOwnerChatStore((state) => state.messages);
  const ownerChatLoading = useOwnerChatStore((state) => state.loading);
  const ownerChatRoomId = useOwnerChatStore((state) => state.roomId);
  const normalizedSearchQuery = searchQuery.trim().toLowerCase();
  // Agent-centric rooms (overview.rooms) ∪ Human-centric rooms (humanRooms),
  // deduped by room_id. When callers pass propsRooms explicitly we honour
  // that and skip the merge. Human rows coexist in the same list so the
  // Sidebar feels identity-agnostic.
  const rooms = (() => {
    if (propsRooms) return propsRooms;
    const agentRooms = overview?.rooms ?? [];
    if (humanRooms.length === 0) return agentRooms;
    const seen = new Set(agentRooms.map((r) => r.room_id));
    const extras = humanRooms
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

  const handleSelect = async (room: DashboardRoom) => {
    if (isOwnerChatRoom(room.room_id)) {
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
    router.push("/chats/messages");
  };

  const handleRoomKeyDown = (event: React.KeyboardEvent<HTMLDivElement>, room: DashboardRoom) => {
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

  const handleUserChatKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
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
    return (
      <div className="py-1">
        <SidebarListSkeleton rows={6} />
      </div>
    );
  }

  return (
    <div className="py-1">
      {showUserChatEntry && (
        <div
          role="button"
          tabIndex={0}
          aria-label={t.userChatAriaLabel}
          aria-current={messagesPane === "user-chat" ? "page" : undefined}
          title={t.userChatTooltip}
          onClick={handleSelectUserChat}
          onKeyDown={handleUserChatKeyDown}
          className={`relative w-full border-l-2 px-4 py-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neon-cyan/60 ${
            messagesPane === "user-chat"
              ? "border-neon-cyan bg-neon-cyan/10"
              : isOwnerChatEmpty
                ? "border-neon-cyan/50 bg-neon-cyan/[0.06] animate-[pulse-border_2s_ease-in-out_infinite]"
                : "border-transparent hover:bg-glass-bg"
          }`}
        >
          <div className="flex items-center gap-3">
            <div className={`relative flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border text-neon-cyan ${
              isOwnerChatEmpty ? "border-neon-cyan/50 bg-neon-cyan/15" : "border-neon-cyan/30 bg-neon-cyan/10"
            }`}>
              {isOwnerChatEmpty && (
                <div className="absolute inset-0 rounded-xl bg-neon-cyan/20 blur-md animate-pulse" />
              )}
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" className="relative h-5 w-5">
                <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 8.25h9m-9 3H12m-9.75 1.51c0 1.6 1.123 2.994 2.707 3.227 1.129.166 2.27.293 3.423.379.35.026.67.21.865.501L12 21l2.755-4.133a1.14 1.14 0 0 1 .865-.501 48.172 48.172 0 0 0 3.423-.379c1.584-.233 2.707-1.626 2.707-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0 0 12 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018Z" />
              </svg>
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-2">
                <span className={`truncate text-sm font-medium flex items-center gap-2 ${messagesPane === "user-chat" ? "text-neon-cyan" : "text-text-primary"}`}>
                  {t.userChatTitle}
                  <span className="rounded-full border border-neon-cyan/35 bg-neon-cyan/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-neon-cyan">
                    {t.userChatBadge}
                  </span>
                  {isOwnerChatEmpty && (
                    <span className="rounded-full bg-neon-green/20 border border-neon-green/40 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-neon-green animate-pulse">
                      {t.userChatOnboardingBadge}
                    </span>
                  )}
                </span>
              </div>
              <p className={`mt-0.5 truncate text-xs ${isOwnerChatEmpty ? "text-neon-cyan/70" : "text-text-secondary"}`}>
                {isOwnerChatEmpty ? t.userChatOnboardingPreview : t.userChatPreview}
              </p>
            </div>
          </div>
        </div>
      )}
      {rooms.length === 0 && !showUserChatEntry && (
        <div className="p-4 text-center text-xs text-text-secondary">
          {t.noRooms}
        </div>
      )}
      {rooms.map((room) => {
        const ownerChatAgentId = isOwnerChatRoom(room.room_id) ? room._originAgent?.agent_id || room.owner_id : null;
        const isSelected = ownerChatAgentId
          ? messagesPane === "user-chat" && ownerChatAgentId === (userChatAgentId || activeAgentId)
          : messagesPane === "room" && focusedRoomId === room.room_id;
        const cachedLatestMessage = cachedLatestMessages[room.room_id] ?? null;
        // Preview text and sender must come from the same source to stay consistent
        let previewText: string;
        let previewSender: string;
        if (room.last_message_preview != null || room.last_sender_name != null) {
          previewText = room.last_message_preview ?? t.noMessagesYet;
          previewSender = room.last_sender_name ?? "";
        } else if (cachedLatestMessage) {
          previewText = cachedLatestMessage.text || t.noMessagesYet;
          previewSender = cachedLatestMessage.sender_name || "";
        } else {
          previewText = t.noMessagesYet;
          previewSender = "";
        }
        const previewLine = previewSender ? `${previewSender}: ${previewText}` : previewText;
        const metaLine = roomMeta?.[room.room_id] ?? null;
        const messageTime = formatLastMessageTime(room.last_message_at || cachedLatestMessage?.created_at || null);
        const selfRoomId = viewMode === "human" ? humanId : activeAgentId;
        const displayName = resolveDmDisplayName(room.room_id, selfRoomId, contacts, room.name);
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
          <div
            key={room.room_id}
            role="button"
            tabIndex={0}
            aria-label={`Open room ${displayName}`}
            aria-current={isSelected ? "page" : undefined}
            onClick={() => void handleSelect(room)}
            onKeyDown={(event) => handleRoomKeyDown(event, room)}
            className={`w-full border-l-2 px-4 py-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neon-cyan/60 ${
              isSelected
                ? "border-neon-cyan bg-neon-cyan/10"
                : "border-transparent hover:bg-glass-bg"
            }`}
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
                    <span className={`min-w-0 truncate text-sm font-medium ${isSelected ? "text-neon-cyan" : "text-text-primary"}`}>
                      {displayName}
                    </span>
                    {!isGroup && room.peer_type === "agent" ? (
                      (() => {
                        // My own bot? owner_id (peer's agent_id) is in my ownedAgents.
                        const isMyBot = room.owner_id && ownedAgentIds.has(room.owner_id);
                        if (isMyBot) {
                          return (
                            <span className="shrink-0 rounded-full border border-neon-cyan/40 bg-neon-cyan/15 px-1.5 py-px text-[9px] font-medium text-neon-cyan">
                              My Bot
                            </span>
                          );
                        }
                        // Third-party bot — show "<owner> 的 Bot" if we know the owner.
                        const peerAgent = room.owner_id ? peerAgentsById.get(room.owner_id) : null;
                        const ownerName = peerAgent?.owner_display_name;
                        const label = ownerName ? tGroup.ownedBotOf(ownerName) : tGroup.externalBot;
                        return (
                          <span className="shrink-0 rounded-full border border-text-secondary/20 bg-text-secondary/10 px-1.5 py-px text-[9px] font-medium text-text-secondary/70">
                            {label}
                          </span>
                        );
                      })()
                    ) : !isGroup && room.peer_type === "human" ? (
                      <span className="shrink-0 rounded-full border border-text-secondary/20 bg-text-secondary/10 px-1.5 py-px text-[9px] font-medium text-text-secondary/70">
                        HUMAN
                      </span>
                    ) : null}
                  </span>
                  <div className="flex shrink-0 items-center gap-2">
                    {unreadCount > 0 && (
                      <span className="flex h-5 min-w-[20px] items-center justify-center rounded-full bg-neon-cyan px-1.5 text-[10px] font-bold leading-none text-black shadow-[0_0_10px_rgba(34,211,238,0.55)]">
                        {formatUnreadCount(unreadCount)}
                      </span>
                    )}
                    {messageTime && (
                      <span className="text-[11px] text-text-secondary/80">
                        {messageTime}
                      </span>
                    )}
                  </div>
                </div>
                {room._originAgent ? (
                  <div className="mt-0.5 flex items-center gap-1 text-[10px] text-text-secondary/55">
                    <span className="inline-flex h-1.5 w-1.5 shrink-0 rounded-full bg-neon-cyan/40" />
                    <span className="truncate">via {room._originAgent.display_name}</span>
                  </div>
                ) : null}
                <div className="mt-0.5 flex items-center gap-1.5">
                  {room.required_subscription_product_id && (
                    <span className="shrink-0">
                      <SubscriptionBadge productId={room.required_subscription_product_id} roomId={room.room_id} />
                    </span>
                  )}
                  <p className="min-w-0 truncate text-xs text-text-secondary">
                    {previewLine}
                  </p>
                </div>
                {metaLine && (
                  <p className="mt-1 truncate text-[10px] text-neon-cyan/70">
                    {metaLine}
                  </p>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
