"use client";

/**
 * [INPUT]: 依赖 session store 获取登录态与当前 agent，依赖 chat store 获取 public rooms/agents，依赖 i18n/dashboard 输出引导文案
 * [OUTPUT]: 对外提供 RoomZeroState 组件，直接展示热门 public rooms 和 agents 供用户一键加入/查看
 * [POS]: messages 空态的统一引导层，被 Sidebar 与 ChatPane 复用，避免无房间时出现死胡同
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

import { useEffect, useState } from "react";
import { useRouter } from "nextjs-toploader/app";
import { useShallow } from "zustand/react/shallow";
import { Users, MessageSquare } from "lucide-react";
import { useLanguage } from "@/lib/i18n";
import { roomZeroState } from "@/lib/i18n/translations/dashboard";
import { useDashboardSessionStore } from "@/store/useDashboardSessionStore";
import { useDashboardChatStore } from "@/store/useDashboardChatStore";
import { useDashboardUIStore } from "@/store/useDashboardUIStore";
import CreateRoomModal from "./CreateRoomModal";
import type { PublicRoom, AgentProfile } from "@/lib/types";

interface RoomZeroStateProps {
  compact?: boolean;
  hasRooms?: boolean;
}

const ROOM_LIMIT = 6;
const AGENT_LIMIT = 4;

export default function RoomZeroState({ compact = false, hasRooms = false }: RoomZeroStateProps) {
  const router = useRouter();
  const sessionMode = useDashboardSessionStore((state) => state.sessionMode);
  const human = useDashboardSessionStore((state) => state.human);
  const ownedAgents = useDashboardSessionStore((state) => state.ownedAgents);
  const locale = useLanguage();
  const t = roomZeroState[locale];
  const [showCreateRoom, setShowCreateRoom] = useState(false);
  const [joiningId, setJoiningId] = useState<string | null>(null);

  const { publicRooms, publicAgents, publicRoomsLoaded, publicAgentsLoaded, loadPublicRooms, loadPublicAgents, joinRoom, selectAgent } =
    useDashboardChatStore(
      useShallow((state) => ({
        publicRooms: state.publicRooms,
        publicAgents: state.publicAgents,
        publicRoomsLoaded: state.publicRoomsLoaded,
        publicAgentsLoaded: state.publicAgentsLoaded,
        loadPublicRooms: state.loadPublicRooms,
        loadPublicAgents: state.loadPublicAgents,
        joinRoom: state.joinRoom,
        selectAgent: state.selectAgent,
      })),
    );

  const { setFocusedRoomId, setOpenedRoomId, setSidebarTab } = useDashboardUIStore(
    useShallow((state) => ({
      setFocusedRoomId: state.setFocusedRoomId,
      setOpenedRoomId: state.setOpenedRoomId,
      setSidebarTab: state.setSidebarTab,
    })),
  );

  useEffect(() => {
    if (!publicRoomsLoaded) loadPublicRooms();
    if (!publicAgentsLoaded) loadPublicAgents();
  }, [publicRoomsLoaded, publicAgentsLoaded, loadPublicRooms, loadPublicAgents]);

  const isGuest = sessionMode === "guest";
  const isHumanFirstTime = !isGuest && human && ownedAgents.length === 0;
  const titleCopy = hasRooms ? t.selectTitle : isHumanFirstTime ? t.humanTitle : t.title;
  const descCopy = hasRooms ? t.selectDescription : isHumanFirstTime ? t.humanDescription : t.description;

  const topRooms = [...publicRooms]
    .sort((a, b) => b.member_count - a.member_count)
    .slice(0, ROOM_LIMIT);
  const topAgents = publicAgents.slice(0, AGENT_LIMIT);

  const handleJoin = async (room: PublicRoom) => {
    if (isGuest) { router.push("/login"); return; }
    setJoiningId(room.room_id);
    await joinRoom(room.room_id);
    setJoiningId(null);
    setFocusedRoomId(room.room_id);
    setOpenedRoomId(room.room_id);
    setSidebarTab("messages");
    router.push(`/chats/messages/${encodeURIComponent(room.room_id)}`);
  };

  const handleOpenRoom = (room: PublicRoom) => {
    setFocusedRoomId(room.room_id);
    setOpenedRoomId(room.room_id);
    setSidebarTab("messages");
    router.push(`/chats/messages/${encodeURIComponent(room.room_id)}`);
  };

  if (compact) {
    return (
      <div className="m-3 rounded-2xl border border-dashed border-glass-border bg-glass-bg/30 p-4">
        <p className="text-sm font-semibold text-text-primary">{titleCopy}</p>
        <p className="mt-1 text-xs leading-5 text-text-secondary">{descCopy}</p>
        <div className="mt-3 flex flex-col gap-2">
          {!isGuest && human && (
            <button
              type="button"
              onClick={() => setShowCreateRoom(true)}
              className="rounded-xl border border-neon-purple/40 bg-neon-purple/10 px-4 py-2 text-xs font-medium text-neon-purple transition-colors hover:bg-neon-purple/20"
            >
              {locale === "zh" ? "创建房间" : "Create a room"}
            </button>
          )}
          <button
            type="button"
            onClick={() => router.push("/chats/explore/rooms")}
            className="rounded-xl border border-glass-border bg-deep-black-light px-4 py-2 text-xs font-medium text-text-primary transition-colors hover:border-neon-cyan/35 hover:text-neon-cyan"
          >
            {t.openExplore}
          </button>
          {isGuest && (
            <button
              type="button"
              onClick={() => router.push("/login")}
              className="rounded-xl border border-neon-cyan/25 bg-neon-cyan/10 px-4 py-2 text-xs font-medium text-neon-cyan transition-colors hover:bg-neon-cyan/20"
            >
              {t.loginToCreate}
            </button>
          )}
        </div>
        {showCreateRoom && <CreateRoomModal onClose={() => setShowCreateRoom(false)} />}
      </div>
    );
  }

  return (
    <div className="flex w-full max-w-2xl flex-col gap-8">
      <div className="text-center">
        <p className="text-base font-semibold text-text-primary">{titleCopy}</p>
        <p className="mt-2 text-sm leading-6 text-text-secondary">{descCopy}</p>
        <div className="mt-4 flex flex-wrap justify-center gap-3">
          {!isGuest && human && (
            <button
              type="button"
              onClick={() => setShowCreateRoom(true)}
              className="rounded-xl border border-neon-purple/40 bg-neon-purple/10 px-4 py-2 text-xs font-medium text-neon-purple transition-colors hover:bg-neon-purple/20"
            >
              {locale === "zh" ? "创建房间" : "Create a room"}
            </button>
          )}
          {isGuest && (
            <button
              type="button"
              onClick={() => router.push("/login")}
              className="rounded-xl border border-neon-cyan/25 bg-neon-cyan/10 px-4 py-2 text-xs font-medium text-neon-cyan transition-colors hover:bg-neon-cyan/20"
            >
              {t.loginToCreate}
            </button>
          )}
        </div>
      </div>

      {topRooms.length > 0 && (
        <section>
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-text-secondary">{t.trendingRooms}</h3>
            <button
              type="button"
              onClick={() => router.push("/chats/explore/rooms")}
              className="text-xs text-neon-purple hover:text-neon-purple/80 transition-colors"
            >
              {t.viewAllRooms}
            </button>
          </div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {topRooms.map((room) => (
              <div
                key={room.room_id}
                className="flex flex-col gap-2 rounded-xl border border-glass-border bg-glass-bg p-3 transition-colors hover:border-neon-purple/25"
              >
                <div className="flex items-start justify-between gap-2">
                  <p
                    className="line-clamp-1 cursor-pointer text-xs font-semibold text-text-primary hover:text-neon-purple transition-colors"
                    onClick={() => handleOpenRoom(room)}
                  >
                    {room.name}
                  </p>
                  <span className="flex shrink-0 items-center gap-1 text-xs text-text-secondary">
                    <Users size={10} />
                    {room.member_count}
                  </span>
                </div>
                {room.last_message_preview && (
                  <div className="flex items-start gap-1.5 rounded-lg bg-white/[0.03] px-2 py-1.5">
                    <MessageSquare size={9} className="mt-0.5 shrink-0 text-neon-cyan/50" />
                    <p className="line-clamp-1 text-xs text-text-secondary/70">
                      {room.last_sender_name && (
                        <span className="font-medium text-neon-cyan/70">{room.last_sender_name}: </span>
                      )}
                      {room.last_message_preview}
                    </p>
                  </div>
                )}
                <button
                  type="button"
                  disabled={joiningId === room.room_id}
                  onClick={() => handleJoin(room)}
                  className="mt-auto rounded-lg border border-neon-purple/30 bg-neon-purple/10 px-3 py-1 text-xs font-medium text-neon-purple transition-colors hover:bg-neon-purple/20 disabled:opacity-50"
                >
                  {joiningId === room.room_id ? t.joining : t.join}
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      {topAgents.length > 0 && (
        <section>
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-text-secondary">{t.featuredAgents}</h3>
            <button
              type="button"
              onClick={() => router.push("/chats/explore/agents")}
              className="text-xs text-neon-cyan hover:text-neon-cyan/80 transition-colors"
            >
              {t.viewAllAgents}
            </button>
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {topAgents.map((agent) => (
              <div
                key={agent.agent_id}
                className="flex flex-col gap-1.5 rounded-xl border border-glass-border bg-glass-bg p-3 transition-colors hover:border-neon-cyan/25"
              >
                <div className="flex items-center gap-2">
                  <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-neon-cyan/10 text-xs font-bold text-neon-cyan">
                    {agent.display_name.charAt(0).toUpperCase()}
                  </div>
                  <p className="line-clamp-1 text-xs font-semibold text-text-primary">{agent.display_name}</p>
                </div>
                {agent.bio && (
                  <p className="line-clamp-2 text-xs text-text-secondary">{agent.bio}</p>
                )}
                <button
                  type="button"
                  onClick={() => selectAgent(agent.agent_id)}
                  className="mt-auto rounded-lg border border-glass-border px-3 py-1 text-xs font-medium text-text-primary transition-colors hover:border-neon-cyan/35 hover:text-neon-cyan"
                >
                  {t.viewProfile}
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      {showCreateRoom && <CreateRoomModal onClose={() => setShowCreateRoom(false)} />}
    </div>
  );
}
