"use client";

import { useMemo } from "react";
import { Bot, ChevronsLeft, Inbox, User, Users } from "lucide-react";
import { useShallow } from "zustand/shallow";
import { useDashboardChatStore } from "@/store/useDashboardChatStore";
import { useDashboardSessionStore } from "@/store/useDashboardSessionStore";
import { useDashboardUIStore } from "@/store/useDashboardUIStore";
import { buildVisibleMessageRooms } from "@/store/dashboard-shared";
import { mergeOwnerVisibleRooms } from "@/lib/messages-merge";
import type { DashboardRoom } from "@/lib/types";

type FilterKey = "all" | "bots" | "humans" | "groups";

interface FilterDef {
  key: FilterKey;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}

const FILTER_DEFS: FilterDef[] = [
  { key: "all", label: "全部", icon: Inbox },
  { key: "bots", label: "Bot", icon: Bot },
  { key: "humans", label: "真人", icon: User },
  { key: "groups", label: "群聊", icon: Users },
];

function countByFilter(rooms: DashboardRoom[]): Record<FilterKey, number> {
  const dms = rooms.filter((r) => (r.member_count ?? 0) <= 2);
  return {
    all: rooms.length,
    bots: dms.filter((r) => r.peer_type !== "human").length,
    humans: dms.filter((r) => r.peer_type === "human").length,
    groups: rooms.filter((r) => (r.member_count ?? 0) > 2).length,
  };
}

export default function MessagesGroupingSidebar() {
  const { ownedAgents, token, humanRooms } = useDashboardSessionStore(
    useShallow((s) => ({
      ownedAgents: s.ownedAgents,
      token: s.token,
      humanRooms: s.humanRooms,
    })),
  );
  const { overview, recentVisitedRooms } = useDashboardChatStore(
    useShallow((s) => ({ overview: s.overview, recentVisitedRooms: s.recentVisitedRooms })),
  );
  const { messagesFilter, setMessagesFilter, setMessagesGroupingOpen } = useDashboardUIStore(
    useShallow((s) => ({
      messagesFilter: s.messagesFilter,
      setMessagesFilter: s.setMessagesFilter,
      setMessagesGroupingOpen: s.setMessagesGroupingOpen,
    })),
  );

  const counts = useMemo(() => {
    const ownRooms = buildVisibleMessageRooms({ overview, recentVisitedRooms, token, humanRooms });
    const merged = mergeOwnerVisibleRooms({ ownedAgents, ownRooms });
    return countByFilter(merged);
  }, [overview, recentVisitedRooms, token, humanRooms, ownedAgents]);

  return (
    <div className="flex h-full w-[180px] shrink-0 flex-col border-r border-glass-border bg-deep-black/50">
      <div className="flex h-14 items-center justify-between border-b border-glass-border px-3">
        <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-text-secondary/70">分组</span>
        <button
          onClick={() => setMessagesGroupingOpen(false)}
          title="收起"
          aria-label="收起"
          className="flex h-7 w-7 items-center justify-center rounded-md text-text-secondary/60 transition-colors hover:bg-glass-bg hover:text-text-primary"
        >
          <ChevronsLeft className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto py-1">
        {FILTER_DEFS.map((f) => {
          const Icon = f.icon;
          const active = messagesFilter === f.key;
          const count = counts[f.key];
          return (
            <button
              key={f.key}
              onClick={() => setMessagesFilter(f.key)}
              className={`flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors ${
                active
                  ? "bg-neon-cyan/10 text-neon-cyan"
                  : "text-text-secondary hover:bg-glass-bg/50 hover:text-text-primary"
              }`}
            >
              <Icon className="h-4 w-4 shrink-0" />
              <span className="flex-1 text-sm font-medium">{f.label}</span>
              <span className={`shrink-0 rounded-full px-1.5 text-[10px] ${
                active ? "bg-neon-cyan/20 text-neon-cyan" : "bg-text-secondary/15 text-text-secondary/70"
              }`}>
                {count}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
