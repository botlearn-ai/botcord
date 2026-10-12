"use client";

/**
 * [INPUT]: 依赖 session store 获取登录态与当前 agent，依赖 chat store 获取 public rooms/agents，依赖 i18n/dashboard 输出引导文案
 * [OUTPUT]: 对外提供 RoomZeroState 组件，直接展示热门 public rooms 和 agents 供用户一键加入/查看
 * [POS]: messages 空态的统一引导层，被 Sidebar 与 ChatPane 复用，避免无房间时出现死胡同
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

import EmptyState from "@/components/ui/EmptyState";
import Button from "@/components/ui/Button";
import Card from "@/components/ui/Card";
import { useEffect, useState } from "react";
import { useRouter } from "nextjs-toploader/app";
import { useShallow } from "zustand/react/shallow";
import { useLanguage } from "@/lib/i18n";
import { roomZeroState } from "@/lib/i18n/translations/dashboard";
import { useDashboardSessionStore } from "@/store/useDashboardSessionStore";
import { useDashboardChatStore } from "@/store/useDashboardChatStore";
import { useDashboardUIStore } from "@/store/useDashboardUIStore";
import { initialsFromName, themeFromRoomName } from "./roomVisualTheme";
import CreateRoomModal from "./CreateRoomModal";
import type { PublicHumanProfile, PublicRoom } from "@/lib/types";

interface RoomZeroStateProps {
  compact?: boolean;
  hasRooms?: boolean;
  onHumanOpen?: (human: PublicHumanProfile) => void;
}

const ROOM_LIMIT = 6;
const AGENT_LIMIT = 4;

export default function RoomZeroState({ compact = false, hasRooms = false, onHumanOpen }: RoomZeroStateProps) {
  const router = useRouter();
  const sessionMode = useDashboardSessionStore((state) => state.sessionMode);
  const human = useDashboardSessionStore((state) => state.human);
  const ownedAgents = useDashboardSessionStore((state) => state.ownedAgents);
  const locale = useLanguage();
  const t = roomZeroState[locale];
  const [showCreateRoom, setShowCreateRoom] = useState(false);
  const [joiningId, setJoiningId] = useState<string | null>(null);

  const { publicRooms, publicAgents, publicHumans, publicRoomsLoaded, publicAgentsLoaded, publicHumansLoaded, loadPublicRooms, loadPublicAgents, loadPublicHumans, joinRoom, selectAgent } =
    useDashboardChatStore(
      useShallow((state) => ({
        publicRooms: state.publicRooms,
        publicAgents: state.publicAgents,
        publicHumans: state.publicHumans,
        publicRoomsLoaded: state.publicRoomsLoaded,
        publicAgentsLoaded: state.publicAgentsLoaded,
        publicHumansLoaded: state.publicHumansLoaded,
        loadPublicRooms: state.loadPublicRooms,
        loadPublicAgents: state.loadPublicAgents,
        loadPublicHumans: state.loadPublicHumans,
        joinRoom: state.joinRoom,
        selectAgent: state.selectAgent,
      })),
    );

  const { setFocusedRoomId, setOpenedRoomId, setSidebarTab, setMessagesPane, setMessagesFilter } = useDashboardUIStore(
    useShallow((state) => ({
      setFocusedRoomId: state.setFocusedRoomId,
      setOpenedRoomId: state.setOpenedRoomId,
      setSidebarTab: state.setSidebarTab,
      setMessagesPane: state.setMessagesPane,
      setMessagesFilter: state.setMessagesFilter,
    })),
  );

  const handleCreatedRoom = (room: { room_id: string }) => {
    setShowCreateRoom(false);
    setSidebarTab("messages");
    setMessagesPane("room");
    setMessagesFilter("self-all");
    setFocusedRoomId(room.room_id);
    setOpenedRoomId(room.room_id);
    router.push("/chats/messages");
  };

  useEffect(() => {
    if (!publicRoomsLoaded) loadPublicRooms();
    if (!publicAgentsLoaded) loadPublicAgents();
    if (!publicHumansLoaded) loadPublicHumans();
  }, [publicRoomsLoaded, publicAgentsLoaded, publicHumansLoaded, loadPublicRooms, loadPublicAgents, loadPublicHumans]);

  const isGuest = sessionMode === "guest";
  const isHumanFirstTime = !isGuest && human && ownedAgents.length === 0;
  const titleCopy = hasRooms ? t.selectTitle : isHumanFirstTime ? t.humanTitle : t.title;
  const descCopy = hasRooms ? t.selectDescription : isHumanFirstTime ? t.humanDescription : t.description;

  const topRooms = [...publicRooms]
    .sort((a, b) => b.member_count - a.member_count)
    .slice(0, ROOM_LIMIT);
  const topAgents = publicAgents.slice(0, AGENT_LIMIT);
  const topHumans = publicHumans.slice(0, AGENT_LIMIT);

  const handleJoin = async (room: PublicRoom) => {
    if (isGuest) { router.push("/login"); return; }
    setJoiningId(room.room_id);
    await joinRoom(room.room_id);
    setJoiningId(null);
    setMessagesPane("room");
    setFocusedRoomId(room.room_id);
    setOpenedRoomId(room.room_id);
    setSidebarTab("messages");
    router.push("/chats/messages");
  };

  const handleOpenRoom = (room: PublicRoom) => {
    setMessagesPane("room");
    setFocusedRoomId(room.room_id);
    setOpenedRoomId(room.room_id);
    setSidebarTab("messages");
    router.push("/chats/messages");
  };

  if (compact) {
    return (
      <EmptyState compact bordered title={<>{titleCopy}</>} description={<>{descCopy}</>} action={<><div className="mt-3 flex flex-col gap-2">
          {!isGuest && human && (
            <Button variant="secondary" size="sm"
              type="button"
              onClick={() => setShowCreateRoom(true)}

            >
              {locale === "zh" ? "创建房间" : "Create a room"}
            </Button>
          )}
          <Button variant="secondary" size="sm"
            type="button"
            onClick={() => router.push("/chats/explore/rooms")}

          >
            {t.openExplore}
          </Button>
          {isGuest && (
            <Button variant="secondary" size="sm"
              type="button"
              onClick={() => router.push("/login")}

            >
              {t.loginToCreate}
            </Button>
          )}
        </div>
{showCreateRoom && <CreateRoomModal onClose={() => setShowCreateRoom(false)} onCreated={handleCreatedRoom} />}</>} />
    );
  }

  return (
    <div className="flex w-full max-w-2xl flex-col gap-8">
      <div className="text-center">
        <p className="text-base font-semibold text-text-primary">{titleCopy}</p>
        <p className="mt-2 text-sm leading-6 text-text-secondary">{descCopy}</p>
        <div className="mt-4 flex flex-wrap justify-center gap-3">
          {!isGuest && human && (
            <Button variant="secondary" size="sm"
              type="button"
              onClick={() => setShowCreateRoom(true)}

            >
              {locale === "zh" ? "创建房间" : "Create a room"}
            </Button>
          )}
          {isGuest && (
            <Button variant="secondary" size="sm"
              type="button"
              onClick={() => router.push("/login")}

            >
              {t.loginToCreate}
            </Button>
          )}
        </div>
      </div>

      {topRooms.length > 0 && (
        <section>
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-text-secondary">{t.trendingRooms}</h3>
            <Button variant="inline"
              type="button"
              onClick={() => router.push("/chats/explore/rooms")}

            >
              {t.viewAllRooms}
            </Button>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {topRooms.map((room) => {
              const theme = themeFromRoomName(room.name || room.room_id);
              const initials = initialsFromName(room.name || "Room");
              const memberWord = room.member_count === 1 ? "Member" : "Members";
              return (
                <Card as="button" variant="interactive" padding="md"
                  key={room.room_id}
                  type="button"
                  disabled={joiningId === room.room_id}
                  onClick={() => handleJoin(room)}
                  className="group overflow-hidden disabled:opacity-60"
                >
                  <div
                    className="relative h-14 w-full"
                    style={{
                      backgroundImage: theme.patternUrl,
                      backgroundRepeat: "repeat",
                      backgroundSize: "auto",
                    }}
                  >
                    <div className="absolute left-3 top-2">
                      <div
                        className="flex h-7 w-7 items-center justify-center rounded-md text-xs font-semibold text-white/90 backdrop-blur-sm"
                        style={{ background: theme.accentDim, boxShadow: `0 0 0 1px ${theme.accent}55` }}
                      >
                        {initials}
                      </div>
                    </div>
                    <span
                      className="absolute right-2 top-2 rounded-full bg-black/40 px-2 py-0.5 text-xs font-medium text-[#ffffff]/90 backdrop-blur-sm"
                      style={{ boxShadow: `0 0 0 1px ${theme.accent}55` }}
                    >
                      {room.member_count} {memberWord}
                    </span>
                  </div>
                  <div className="px-3 py-2">
                    <p className="truncate text-sm font-semibold text-text-primary">{room.name}</p>
                    <p className="mt-1 line-clamp-2 text-xs leading-4 text-text-secondary">
                      {room.description || (locale === "zh" ? "暂无描述" : "No description yet.")}
                    </p>
                  </div>
                </Card>
              );
            })}
          </div>
        </section>
      )}

      {topAgents.length > 0 && (
        <section>
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-text-secondary">{t.featuredAgents}</h3>
            <Button variant="inline"
              type="button"
              onClick={() => router.push("/chats/explore/agents")}

            >
              {t.viewAllAgents}
            </Button>
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {topAgents.map((agent) => {
              const initials = initialsFromName(agent.display_name);
              return (
                <Card as="button" variant="interactive" padding="md"
                  key={agent.agent_id}
                  type="button"
                  onClick={() => selectAgent(agent.agent_id)}
                  className="group"
                >
                  <div className="mb-2 flex items-center gap-2">
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-full border border-neon-cyan/30 bg-accent-soft text-xs font-semibold text-accent-text">
                      {agent.avatar_url ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={agent.avatar_url} alt={agent.display_name} className="h-full w-full object-cover" />
                      ) : (
                        initials
                      )}
                    </div>
                    <p className="line-clamp-1 text-sm font-semibold text-text-primary">{agent.display_name}</p>
                  </div>
                  {agent.bio && (
                    <p className="line-clamp-2 text-xs leading-4 text-text-secondary">{agent.bio}</p>
                  )}
                </Card>
              );
            })}
          </div>
        </section>
      )}

      {topHumans.length > 0 && onHumanOpen && (
        <section>
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-text-secondary">{t.featuredHumans}</h3>
            <Button variant="inline"
              type="button"
              onClick={() => router.push("/chats/explore/humans")}

            >
              {t.viewAllHumans}
            </Button>
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {topHumans.map((human) => {
              const initials = initialsFromName(human.display_name);
              return (
                <Card as="button" variant="interactive" padding="md"
                  key={human.human_id}
                  type="button"
                  onClick={() => onHumanOpen(human)}
                  className="group"
                >
                  <div className="mb-2 flex items-center gap-2">
                    {human.avatar_url ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={human.avatar_url}
                        alt={human.display_name}
                        className="h-9 w-9 shrink-0 rounded-full border border-neon-green/30 object-cover"
                      />
                    ) : (
                      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-neon-green/30 bg-success-soft text-xs font-semibold text-success">
                        {initials}
                      </div>
                    )}
                    <p className="line-clamp-1 text-sm font-semibold text-text-primary">{human.display_name}</p>
                  </div>
                  <p className="text-xs text-success">{locale === "zh" ? "Human 用户" : "Human"}</p>
                </Card>
              );
            })}
          </div>
        </section>
      )}

      {showCreateRoom && <CreateRoomModal onClose={() => setShowCreateRoom(false)} onCreated={handleCreatedRoom} />}
    </div>
  );
}
