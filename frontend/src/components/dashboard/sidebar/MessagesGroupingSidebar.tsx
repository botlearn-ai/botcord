"use client";

import { useConversationDirectoryStore } from "@/store/useConversationDirectoryStore";
import Badge from "@/components/ui/Badge";
import IconButton from "@/components/ui/IconButton";
import Button from "@/components/ui/Button";
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

interface MessagesGroupingSidebarProps {
  fullWidth?: boolean;
  onCollapse?: () => void;
  onFilterSelect?: () => void;
}

export default function MessagesGroupingSidebar({
  fullWidth = false,
  onCollapse,
  onFilterSelect,
}: MessagesGroupingSidebarProps = {}) {
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

  const directory = useConversationDirectoryStore();
  const counts = useMemo(() => {
    const ownRooms = buildVisibleMessageRooms({ overview, recentVisitedRooms, token, humanRooms });
    const merged = directory.accountId ? directory.rooms : mergeOwnerVisibleRooms({ ownedAgentRooms, ownRooms });
    const ids = new Set(ownedAgents.map((agent) => agent.agent_id));
    return countMessagesByFilter(merged, ids);
  }, [overview, recentVisitedRooms, token, humanRooms, ownedAgents, ownedAgentRooms, directory.accountId, directory.rooms]);

  const [selfOpen, setSelfOpen] = useState(true);
  const [botsOpen, setBotsOpen] = useState(true);
  const selectFilter = (filter: MessagesFilterKey) => {
    setMessagesShowRequests(false);
    if (messagesFilter !== filter) {
      setMessagesFilter(filter);
      setMessagesPane("room");
      setFocusedRoomId(null);
      setOpenedRoomId(null);
      setOpenedTopicId(null);
      router.push("/chats/messages");
    }
    onFilterSelect?.();
  };

  return (
    <div className={`liquid-rail flex h-full ${fullWidth ? "w-full" : "w-[200px]"} shrink-0 flex-col border-r border-glass-border`}>
      <div className="liquid-toolbar flex h-14 items-center justify-between border-b border-glass-border px-3">
        <span className="text-xs font-semibold uppercase tracking-[0.16em] text-text-secondary">{t.header}</span>
        <IconButton size="sm" label={t.collapse}
          type="button"
          onClick={() => (onCollapse ? onCollapse() : setMessagesGroupingOpen(false))}
          title={t.collapse}
          aria-label={t.collapse}
          className="flex items-center justify-center"
        >
          <ChevronsLeft className="h-3.5 w-3.5" />
        </IconButton>
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
    <Button variant="row"
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      className="flex w-full items-center gap-1.5"
    >
      {open ? (
        <ChevronDown className="h-3 w-3 shrink-0 text-text-secondary" />
      ) : (
        <ChevronRight className="h-3 w-3 shrink-0 text-text-secondary" />
      )}
      <Icon className="h-3.5 w-3.5 shrink-0 text-text-secondary" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-xs font-semibold uppercase tracking-[0.1em] text-text-secondary">
          {title}
        </div>
        <div className="truncate text-xs text-text-secondary">{subtitle}</div>
      </div>
      <span className="shrink-0 text-xs text-text-secondary">{count}</span>
    </Button>
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
    <Button variant="row" aria-pressed={active}
      type="button"
      onClick={onClick}
      className={`flex w-full items-center justify-between gap-2 `}
    >
      <span className="flex min-w-0 items-center gap-2">
        <Icon className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate">{row.label}</span>
      </span>
      <Badge tone="accent" >
        {count}
      </Badge>
    </Button>
  );
}
