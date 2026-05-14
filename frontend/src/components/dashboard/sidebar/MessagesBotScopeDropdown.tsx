"use client";

import { useMemo } from "react";
import { Sparkles } from "lucide-react";
import { useShallow } from "zustand/shallow";
import { useDashboardSessionStore } from "@/store/useDashboardSessionStore";
import { useDashboardUIStore } from "@/store/useDashboardUIStore";
import type { DashboardRoom } from "@/lib/types";
import BotAvatar from "../BotAvatar";

interface Props {
  /** Rooms already narrowed by the current type filter (bots-* family). */
  rooms: DashboardRoom[];
}

/**
 * Feishu-style horizontal avatar row above the Messages list. Lets the owner
 * pick a single owned bot (or "all") to narrow what they observe in Bot 监控.
 * Only rendered when the active type filter is in the bots-* family.
 *
 * Despite the file name, this is no longer a dropdown — kept as the same
 * file to avoid churn on import paths.
 */
export default function MessagesBotScopeDropdown({ rooms }: Props) {
  const ownedAgents = useDashboardSessionStore((s) => s.ownedAgents);
  const { messagesBotScope, setMessagesBotScope } = useDashboardUIStore(
    useShallow((s) => ({
      messagesBotScope: s.messagesBotScope,
      setMessagesBotScope: s.setMessagesBotScope,
    })),
  );

  const counts = useMemo(() => {
    const m: Record<string, number> = { all: rooms.length };
    for (const r of rooms) {
      const id = r._originAgent?.agent_id;
      if (id) m[id] = (m[id] ?? 0) + 1;
    }
    return m;
  }, [rooms]);

  return (
    <div className="-mx-0.5 flex items-start gap-3 overflow-x-auto px-0.5 py-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      <Item
        key="all"
        label="我的全部 Bots"
        active={messagesBotScope === "all"}
        count={counts["all"] ?? 0}
        onClick={() => setMessagesBotScope("all")}
        avatar={
          <div className="flex h-9 w-9 items-center justify-center rounded-full border border-text-secondary/25 bg-text-secondary/10 text-text-secondary/90">
            <Sparkles className="h-4 w-4" />
          </div>
        }
      />
      {ownedAgents.map((agent) => (
        <Item
          key={agent.agent_id}
          label={agent.display_name}
          active={messagesBotScope === agent.agent_id}
          count={counts[agent.agent_id] ?? 0}
          onClick={() => setMessagesBotScope(agent.agent_id)}
          avatar={<BotAvatar agentId={agent.agent_id} avatarUrl={agent.avatar_url} size={36} alt={agent.display_name} />}
        />
      ))}
    </div>
  );
}

function Item({
  label,
  count,
  active,
  avatar,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  avatar: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      title={`${label} (${count})`}
      className="flex w-[68px] shrink-0 flex-col items-center gap-2 px-0.5 pt-0.5 outline-none"
    >
      <span
        className={`relative flex h-9 w-9 items-center justify-center rounded-full transition-all ${
          active
            ? "ring-2 ring-neon-cyan ring-offset-2 ring-offset-deep-black-light"
            : "ring-1 ring-transparent opacity-80 hover:opacity-100"
        }`}
      >
        {avatar}
        {count > 0 ? (
          <span className={`absolute -right-1 -top-1 flex h-4 min-w-[16px] items-center justify-center rounded-full px-1 text-[9px] font-semibold leading-none ${
            active
              ? "bg-neon-cyan text-deep-black"
              : "bg-glass-bg text-text-secondary/80 ring-1 ring-glass-border"
          }`}>
            {count > 99 ? "99+" : count}
          </span>
        ) : null}
      </span>
      <span
        className={`line-clamp-2 w-full break-words text-center text-[10px] leading-tight ${
          active ? "font-medium text-neon-cyan" : "text-text-secondary/75"
        }`}
      >
        {label}
      </span>
    </button>
  );
}
