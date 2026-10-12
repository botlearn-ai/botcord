"use client";
import Disclosure from "@/components/ui/Disclosure";

import { useLanguage } from "@/lib/i18n";
import {
  capabilityBadge,
  replyModeHint,
  teamAccessApi,
  type RoomAgentAccess,
} from "@/lib/team-access";
import { useDashboardChatStore } from "@/store/useDashboardChatStore";
import { Bot, Info } from "lucide-react";
import { useEffect, useState } from "react";
import AccessBadge from "./AccessBadge";

/** What the viewer's messages can make each Agent in an org room do; reloads when members change. */
export function useRoomAgentAccess(
  spaceId: string,
  roomId: string,
): RoomAgentAccess[] {
  const membersVersion = useDashboardChatStore(
    (s) => s.roomMemberVersions[roomId] ?? 0,
  );
  const [agents, setAgents] = useState<RoomAgentAccess[]>([]);
  useEffect(() => {
    const controller = new AbortController();
    teamAccessApi
      .roomAgentAccess(spaceId, roomId, controller.signal)
      .then((res) => {
        if (!controller.signal.aborted) setAgents(res.agents);
      })
      // Advisory UI: keep the last known state rather than block the room.
      .catch(() => undefined);
    return () => controller.abort();
  }, [spaceId, roomId, membersVersion]);
  return agents;
}

/** Chips under the room header: each Agent with my capability (tap for meaning). */
export function RoomAgentChips({ agents }: { agents: RoomAgentAccess[] }) {
  const zh = useLanguage() === "zh";
  if (!agents.length) return null;
  const chips = (
    <ul
      className="flex shrink-0 flex-wrap gap-2 border-b border-glass-border px-4 py-2 max-md:px-2 max-md:flex-nowrap max-md:overflow-x-auto max-md:gap-1.5 max-md:py-1"
      aria-label={
        zh ? "房间里的 Agent 和我的权限" : "Agents here and what you can do"
      }
    >
      {agents.map((agent) => (
        <li
          key={agent.agent_id}
          className="inline-flex max-w-full shrink-0 items-start gap-1.5 rounded-lg border border-glass-border bg-glass-bg px-2 py-1"
        >
          <Bot size={14} className="mt-0.5 shrink-0 text-neon-cyan" />
          <span className="min-w-0 truncate text-xs leading-5">
            {agent.display_name}
          </span>
          <AccessBadge info={capabilityBadge(agent.my_capability, zh)} />
        </li>
      ))}
    </ul>
  );
  return (
    <>
      <div className="hidden md:contents">{chips}</div>
      <Disclosure
        title={
          <>
            <Bot size={13} className="text-neon-cyan" />
            <span>
              {zh
                ? `Agent 与权限 · ${agents.length}`
                : `Agents & permissions · ${agents.length}`}
            </span>
          </>
        }
        className="shrink-0 md:hidden"
      >
        {chips}
      </Disclosure>
    </>
  );
}

/** Above the composer: who won't reply to every message. Empty when all reply always. */
export function RoomReplyHints({ agents }: { agents: RoomAgentAccess[] }) {
  const zh = useLanguage() === "zh";
  const hints = agents
    .map((a) => replyModeHint(a.display_name, a.reply_mode, a.keywords, zh))
    .filter((hint): hint is string => Boolean(hint));
  if (!hints.length) return null;
  return (
    <ul
      className="mb-1.5 space-y-0.5 px-1"
      aria-label={zh ? "回复提示" : "Reply hints"}
    >
      {hints.map((hint) => (
        <li
          key={hint}
          className="flex items-start gap-1.5 text-xs leading-4 text-text-secondary"
        >
          <Info size={12} className="mt-0.5 shrink-0" />
          <span className="min-w-0 break-words">{hint}</span>
        </li>
      ))}
    </ul>
  );
}
