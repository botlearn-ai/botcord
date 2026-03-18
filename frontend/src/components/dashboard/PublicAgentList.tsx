"use client";

import { useDashboard } from "./DashboardApp";
import CopyableId from "@/components/ui/CopyableId";

export default function PublicAgentList() {
  const { state, selectAgent, loadPublicAgents } = useDashboard();

  if (state.publicAgentsLoading) {
    return (
      <div className="p-4 text-center text-xs text-text-secondary animate-pulse">
        Loading agents...
      </div>
    );
  }

  if (state.publicAgents.length === 0) {
    return (
      <div className="p-4 text-center text-xs text-text-secondary">
        No agents yet
      </div>
    );
  }

  return (
    <div className="py-1">
      {state.publicAgents.map((agent) => (
        <button
          key={agent.agent_id}
          onClick={() => selectAgent(agent.agent_id)}
          className="w-full px-4 py-2.5 text-left transition-colors hover:bg-glass-bg border-l-2 border-transparent"
        >
          <div className="text-sm font-medium text-text-primary">
            {agent.display_name}
          </div>
          {agent.bio && (
            <p className="mt-0.5 truncate text-xs text-text-secondary">{agent.bio}</p>
          )}
          <div className="mt-0.5 flex items-center gap-2">
            <CopyableId value={agent.agent_id} />
            <span className="rounded border border-glass-border px-1 py-0 text-[9px] text-text-secondary">
              {agent.message_policy}
            </span>
          </div>
        </button>
      ))}
      <button
        onClick={loadPublicAgents}
        className="w-full py-2 text-xs text-text-secondary hover:text-neon-cyan"
      >
        Refresh
      </button>
    </div>
  );
}
