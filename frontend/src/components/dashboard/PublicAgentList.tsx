"use client";

import EmptyState from "@/components/ui/EmptyState";
import Badge from "@/components/ui/Badge";
import Button from "@/components/ui/Button";
import CopyableId from "@/components/ui/CopyableId";
import { useShallow } from "zustand/react/shallow";
import { useEffect } from "react";
import { useDashboardChatStore } from "@/store/useDashboardChatStore";
import { usePresenceStore } from "@/store/usePresenceStore";
import { MobileBotCordLoading } from "@/components/ui/BotCordLoader";
import { PresenceDot } from "./PresenceDot";

export default function PublicAgentList() {
  const { publicAgents, publicAgentsLoading, selectAgent, loadPublicAgents } = useDashboardChatStore(
    useShallow((state) => ({
      publicAgents: state.publicAgents,
      publicAgentsLoading: state.publicAgentsLoading,
      selectAgent: state.selectAgent,
      loadPublicAgents: state.loadPublicAgents,
    })),
  );

  useEffect(() => {
    if (publicAgents.length === 0) return;
    usePresenceStore.getState().seed(
      publicAgents.map((a) => ({ agentId: a.agent_id, online: Boolean(a.online) })),
    );
  }, [publicAgents]);

  if (publicAgentsLoading && publicAgents.length === 0) {
    return (
      <MobileBotCordLoading
        label="Loading agents..."
        className="p-4"
        textClassName="animate-pulse text-center text-xs text-text-secondary"
      />
    );
  }

  if (publicAgents.length === 0) {
    return (
      <EmptyState compact bordered title={<>No agents yet
      </>} />
    );
  }

  return (
    <div className="py-1">
      {publicAgents.map((agent) => (
        <Button variant="row"
          key={agent.agent_id}
          onClick={() => selectAgent(agent.agent_id)}
          className="w-full"
        >
          <div className="flex items-center gap-2 text-sm font-medium text-text-primary">
            <PresenceDot agentId={agent.agent_id} fallback={agent.online} />
            <span>{agent.display_name}</span>
          </div>
          {agent.bio && (
            <p className="mt-0.5 truncate text-xs text-text-secondary">{agent.bio}</p>
          )}
          <div className="mt-0.5 flex items-center gap-2">
            <CopyableId value={agent.agent_id} />
            <Badge tone="neutral" >
              {agent.message_policy}
            </Badge>
          </div>
        </Button>
      ))}
      <Button variant="secondary" size="sm"
        onClick={() => void loadPublicAgents()}
        className="mx-3 mb-1 w-[calc(100%-1.5rem)]"
      >
        Refresh
      </Button>
    </div>
  );
}
