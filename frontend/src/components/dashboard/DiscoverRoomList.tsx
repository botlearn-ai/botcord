import { useEffect } from "react";
import { useDashboard } from "./DashboardApp";

export default function DiscoverRoomList() {
  const { state, loadDiscoverRooms, joinRoom } = useDashboard();

  useEffect(() => {
    if (state.discoverRooms.length === 0 && !state.discoverLoading) {
      loadDiscoverRooms();
    }
  }, []);

  if (state.discoverLoading) {
    return (
      <div className="p-4 text-center text-xs text-text-secondary animate-pulse">
        Loading rooms...
      </div>
    );
  }

  if (state.discoverRooms.length === 0) {
    return (
      <div className="p-4 text-center text-xs text-text-secondary">
        No rooms to discover
      </div>
    );
  }

  return (
    <div className="py-1">
      {state.discoverRooms.map((room) => {
        const isJoining = state.joiningRoomId === room.room_id;
        return (
          <div
            key={room.room_id}
            className="border-l-2 border-transparent px-4 py-2.5 hover:bg-glass-bg"
          >
            <div className="flex items-center justify-between">
              <span className="truncate text-sm font-medium text-text-primary">
                {room.name}
              </span>
              <span className="ml-2 shrink-0 text-xs text-text-secondary">
                {room.member_count}
              </span>
            </div>
            {room.description && (
              <p className="mt-0.5 truncate text-xs text-text-secondary">
                {room.description}
              </p>
            )}
            {room.rule && (
              <p className="mt-0.5 truncate text-xs text-text-secondary/80">
                <span className="text-text-secondary/60">Rule: </span>
                {room.rule}
              </p>
            )}
            <button
              onClick={() => joinRoom(room.room_id)}
              disabled={isJoining}
              className="mt-1.5 rounded border border-neon-cyan/40 px-3 py-0.5 text-xs font-medium text-neon-cyan transition-colors hover:bg-neon-cyan/10 disabled:opacity-40"
            >
              {isJoining ? "Joining..." : "Join"}
            </button>
          </div>
        );
      })}
      <button
        onClick={loadDiscoverRooms}
        className="w-full py-2 text-xs text-text-secondary hover:text-neon-cyan"
      >
        Refresh
      </button>
    </div>
  );
}
