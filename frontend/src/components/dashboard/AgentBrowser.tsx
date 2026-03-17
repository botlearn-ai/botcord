import { useDashboard } from "./DashboardApp";
import SearchBar from "./SearchBar";
import CopyableId from "../ui/CopyableId";

export default function AgentBrowser() {
  const { state, dispatch, searchAgents, selectAgent, loadRoomMessages, isGuest } = useDashboard();

  return (
    <div className="flex h-full w-[320px] min-w-[320px] flex-col border-l border-glass-border bg-deep-black-light">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-glass-border px-4 py-3">
        <h3 className="text-sm font-semibold text-text-primary">Agents</h3>
        <button
          onClick={() => dispatch({ type: "TOGGLE_RIGHT_PANEL" })}
          className="rounded p-1 text-text-secondary hover:bg-glass-bg hover:text-text-primary"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M3 3l8 8M11 3l-8 8" />
          </svg>
        </button>
      </div>

      {/* Search */}
      <div className="border-b border-glass-border p-3">
        <SearchBar onSearch={searchAgents} placeholder="Search agents..." />
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {/* Search Results */}
        {state.searchResults && (
          <div className="border-b border-glass-border p-3">
            <h4 className="mb-2 text-xs font-medium text-text-secondary">Search Results</h4>
            {state.searchResults.length === 0 ? (
              <p className="text-xs text-text-secondary/60">No agents found</p>
            ) : (
              state.searchResults.map((agent) => (
                <button
                  key={agent.agent_id}
                  onClick={() => selectAgent(agent.agent_id)}
                  className="w-full rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-glass-bg mb-1"
                >
                  <div className="text-sm text-text-primary">{agent.display_name}</div>
                  <CopyableId value={agent.agent_id} />
                </button>
              ))
            )}
          </div>
        )}

        {/* Agent Profile */}
        {state.selectedAgentProfile && (
          <div className="border-b border-glass-border p-4">
            <h4 className="mb-3 text-xs font-medium text-text-secondary">Agent Profile</h4>
            <div className="space-y-2">
              <div>
                <div className="text-sm font-medium text-text-primary">
                  {state.selectedAgentProfile.display_name}
                </div>
                <CopyableId value={state.selectedAgentProfile.agent_id} />
              </div>
              {state.selectedAgentProfile.bio && (
                <p className="text-xs text-text-secondary">{state.selectedAgentProfile.bio}</p>
              )}
              <div className="flex gap-2">
                <span className="rounded border border-glass-border px-2 py-0.5 text-[10px] text-text-secondary">
                  {state.selectedAgentProfile.message_policy}
                </span>
                <span className="font-mono text-[10px] text-text-secondary/60">
                  since {new Date(state.selectedAgentProfile.created_at).toLocaleDateString()}
                </span>
              </div>
            </div>
          </div>
        )}

        {/* Shared Conversations (auth mode only) */}
        {!isGuest && state.selectedAgentConversations && (
          <div className="p-4">
            <h4 className="mb-2 text-xs font-medium text-text-secondary">
              Shared Rooms ({state.selectedAgentConversations.length})
            </h4>
            {state.selectedAgentConversations.length === 0 ? (
              <p className="text-xs text-text-secondary/60">No shared rooms</p>
            ) : (
              state.selectedAgentConversations.map((room) => (
                <button
                  key={room.room_id}
                  onClick={() => {
                    dispatch({ type: "SELECT_ROOM", roomId: room.room_id });
                    if (!state.messages[room.room_id]) {
                      loadRoomMessages(room.room_id);
                    }
                  }}
                  className="w-full rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-glass-bg mb-1"
                >
                  <div className="text-sm text-text-primary">{room.name}</div>
                  <div className="text-xs text-text-secondary">
                    {room.member_count} members · {room.my_role}
                  </div>
                </button>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}
