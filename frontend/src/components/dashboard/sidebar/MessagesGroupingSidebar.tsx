"use client";

import { useMemo, useState } from "react";
import { useRouter } from "nextjs-toploader/app";
import { Bot, ChevronDown, ChevronRight, ChevronsLeft, Eye, Inbox, User, Users, UsersRound } from "lucide-react";
import { useShallow } from "zustand/shallow";
import { useDashboardChatStore } from "@/store/useDashboardChatStore";
import { useDashboardSessionStore } from "@/store/useDashboardSessionStore";
import { useDashboardUIStore } from "@/store/useDashboardUIStore";
import { buildVisibleMessageRooms } from "@/store/dashboard-shared";
import { countMessagesByFilter, mergeOwnerVisibleRooms, type MessagesFilterKey } from "@/lib/messages-merge";
import { useLanguage } from "@/lib/i18n";
import { messagesGrouping as messagesGroupingI18n } from "@/lib/i18n/translations/dashboard";

interface FilterRow {
  key: MessagesFilterKey;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}

export default function MessagesGroupingSidebar() {
  const router = useRouter();
  const t = messagesGroupingI18n[useLanguage()];
  const SELF_ROWS: FilterRow[] = [
    { key: "self-all", label: t.filterAll, icon: Inbox },
    { key: "self-my-bot", label: t.filterSelfMyBot, icon: Bot },
    { key: "self-third-bot", label: t.filterSelfThirdBot, icon: Bot },
    { key: "self-human", label: t.filterSelfHuman, icon: User },
    { key: "self-group", label: t.filterSelfGroup, icon: Users },
  ];
  const BOTS_ROWS: FilterRow[] = [
    { key: "bots-all", label: t.filterAll, icon: Inbox },
    { key: "bots-bot-bot", label: t.filterBotsBotBot, icon: Bot },
    { key: "bots-bot-human", label: t.filterBotsBotHuman, icon: UsersRound },
    { key: "bots-group", label: t.filterBotsGroup, icon: Users },
  ];
  const { ownedAgents, token, humanRooms } = useDashboardSessionStore(
    useShallow((s) => ({
      ownedAgents: s.ownedAgents,
      token: s.token,
      humanRooms: s.humanRooms,
    })),
  );
  const { overview, recentVisitedRooms, ownedAgentRooms } = useDashboardChatStore(
    useShallow((s) => ({
      overview: s.overview,
      recentVisitedRooms: s.recentVisitedRooms,
      ownedAgentRooms: s.ownedAgentRooms,
    })),
  );
  const {
    messagesFilter,
    messagesShowRequests,
    setFocusedRoomId,
    setMessagesFilter,
    setMessagesPane,
    setMessagesShowRequests,
    setOpenedRoomId,
    setOpenedTopicId,
    setMessagesGroupingOpen,
  } = useDashboardUIStore(
    useShallow((s) => ({
      messagesFilter: s.messagesFilter,
      messagesShowRequests: s.messagesShowRequests,
      setFocusedRoomId: s.setFocusedRoomId,
      setMessagesFilter: s.setMessagesFilter,
      setMessagesPane: s.setMessagesPane,
      setMessagesShowRequests: s.setMessagesShowRequests,
      setOpenedRoomId: s.setOpenedRoomId,
      setOpenedTopicId: s.setOpenedTopicId,
      setMessagesGroupingOpen: s.setMessagesGroupingOpen,
    })),
  );

  const counts = useMemo(() => {
    const ownRooms = buildVisibleMessageRooms({ overview, recentVisitedRooms, token, humanRooms });
    const merged = mergeOwnerVisibleRooms({ ownedAgentRooms, ownRooms });
    const ids = new Set(ownedAgents.map((agent) => agent.agent_id));
    return countMessagesByFilter(merged, ids);
  }, [overview, recentVisitedRooms, token, humanRooms, ownedAgents, ownedAgentRooms]);

  const [selfOpen, setSelfOpen] = useState(true);
  const [botsOpen, setBotsOpen] = useState(true);
  const selectFilter = (filter: MessagesFilterKey) => {
    setMessagesShowRequests(false);
    if (messagesFilter === filter) return;
    setMessagesFilter(filter);
    setMessagesPane("room");
    setFocusedRoomId(null);
    setOpenedRoomId(null);
    setOpenedTopicId(null);
    router.push("/chats/messages");
  };

  return (
    <div className="flex h-full w-[200px] shrink-0 flex-col border-r border-glass-border bg-deep-black/50">
      <div className="flex h-14 items-center justify-between border-b border-glass-border px-3">
        <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-text-secondary/70">{t.header}</span>
        <button
          onClick={() => setMessagesGroupingOpen(false)}
          title={t.collapse}
          aria-label={t.collapse}
          className="flex h-7 w-7 items-center justify-center rounded-md text-text-secondary/60 transition-colors hover:bg-glass-bg hover:text-text-primary"
        >
          <ChevronsLeft className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto py-1">
        <GroupHeader
          title={t.selfGroupTitle}
          subtitle={t.selfGroupSubtitle}
          icon={User}
          count={counts["self-all"]}
          open={selfOpen}
          onToggle={() => setSelfOpen((v) => !v)}
        />
        {selfOpen ? (
          <div className="pb-1">
            {SELF_ROWS.map((row) => (
              <FilterButton
                key={row.key}
                row={row}
                count={counts[row.key]}
                active={messagesFilter === row.key && !messagesShowRequests}
                onClick={() => selectFilter(row.key)}
              />
            ))}
          </div>
        ) : null}

        <div className="my-1 border-t border-glass-border/40" />

        <GroupHeader
          title={t.botsGroupTitle}
          subtitle={t.botsGroupSubtitle}
          icon={Eye}
          count={counts["bots-all"]}
          open={botsOpen}
          onToggle={() => setBotsOpen((v) => !v)}
        />
        {botsOpen ? (
          <div className="pb-1">
            {BOTS_ROWS.map((row) => (
              <FilterButton
                key={row.key}
                row={row}
                count={counts[row.key]}
                active={messagesFilter === row.key && !messagesShowRequests}
                onClick={() => selectFilter(row.key)}
              />
            ))}
          </div>
        ) : null}

      </div>
    </div>
  );
}

function GroupHeader({
  title,
  subtitle,
  icon: Icon,
  count,
  open,
  onToggle,
}: {
  title: string;
  subtitle: string;
  icon: React.ComponentType<{ className?: string }>;
  count: number;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      onClick={onToggle}
      className="flex w-full items-center gap-1.5 px-3 py-2 text-left transition-colors hover:bg-glass-bg/40"
    >
      {open ? (
        <ChevronDown className="h-3 w-3 shrink-0 text-text-secondary/60" />
      ) : (
        <ChevronRight className="h-3 w-3 shrink-0 text-text-secondary/40" />
      )}
      <Icon className="h-3.5 w-3.5 shrink-0 text-text-secondary/70" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[11px] font-semibold uppercase tracking-[0.1em] text-text-secondary/85">
          {title}
        </div>
        <div className="truncate text-[10px] text-text-secondary/45">{subtitle}</div>
      </div>
      <span className="shrink-0 text-[10px] text-text-secondary/55">{count}</span>
    </button>
  );
}

function FilterButton({
  row,
  count,
  active,
  onClick,
}: {
  row: FilterRow;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  const Icon = row.icon;
  return (
    <button
      onClick={onClick}
      className={`flex w-full items-center justify-between gap-2 py-1.5 pl-[28px] pr-3 text-[12px] transition-colors ${
        active
          ? "bg-neon-cyan/10 text-neon-cyan"
          : "text-text-secondary hover:bg-glass-bg/50 hover:text-text-primary"
      }`}
    >
      <span className="flex min-w-0 items-center gap-2">
        <Icon className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate">{row.label}</span>
      </span>
      <span className={`shrink-0 rounded-full px-1.5 text-[10px] ${
        active ? "bg-neon-cyan/20 text-neon-cyan" : "bg-text-secondary/15 text-text-secondary/70"
      }`}>
        {count}
      </span>
    </button>
  );
}
