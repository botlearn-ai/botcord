"use client";

import { useLanguage } from "@/lib/i18n";
import BotAvatar from "@/components/dashboard/BotAvatar";
import {
  AGENT_STATUS_DOT,
  agentStatusLabel,
  runtimeLabel,
  type AgentStatus,
  type DirectoryAgent,
} from "@/lib/team-access";

/** Avatar with a presence dot in the corner. */
export function AgentAvatar({
  agentId,
  avatarUrl,
  name,
  status,
  size = 40,
}: {
  agentId: string;
  avatarUrl?: string | null;
  name: string;
  status: AgentStatus;
  size?: number;
}) {
  return (
    <span className="relative shrink-0">
      <BotAvatar agentId={agentId} avatarUrl={avatarUrl} size={size} alt={name} shape="rounded" />
      <span
        aria-hidden
        className={`absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full ring-2 ring-deep-black ${AGENT_STATUS_DOT[status] ?? AGENT_STATUS_DOT.offline}`}
      />
    </span>
  );
}

/** Status dot + label, runtime and owner on one wrapping line. */
export function AgentMeta({ agent }: { agent: DirectoryAgent }) {
  const zh = useLanguage() === "zh";
  const runtime = runtimeLabel(agent.runtime, agent.hosting_kind);
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-text-secondary">
      <span className="inline-flex items-center gap-1.5">
        <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${AGENT_STATUS_DOT[agent.status] ?? AGENT_STATUS_DOT.offline}`} />
        {agentStatusLabel(agent.status, zh)}
      </span>
      {runtime && (
        <span className="rounded-md border border-glass-border bg-glass-bg px-1.5 py-px text-[11px] text-text-primary">
          {runtime}
        </span>
      )}
      <span className="min-w-0 truncate">
        {agent.my_access === "owner"
          ? zh
            ? "我的 Agent"
            : "Your Agent"
          : `${zh ? "所有者" : "Owner"}: ${agent.owner_name || "—"}`}
      </span>
    </span>
  );
}

/** Avatar, name and meta line (drawer header). */
export function AgentIdentity({
  agent,
  size = 40,
  className = "",
}: {
  agent: DirectoryAgent;
  size?: number;
  className?: string;
}) {
  return (
    <span className={`flex items-center gap-3 ${className}`}>
      <AgentAvatar
        agentId={agent.agent_id}
        avatarUrl={agent.avatar_url}
        name={agent.display_name}
        status={agent.status}
        size={size}
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-base font-semibold">{agent.display_name}</span>
        <span className="mt-1 block">
          <AgentMeta agent={agent} />
        </span>
      </span>
    </span>
  );
}
