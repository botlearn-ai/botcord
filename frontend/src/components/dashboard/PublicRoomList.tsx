"use client";

import { useDashboard } from "./DashboardApp";

export default function PublicRoomList() {
  const { state, dispatch, loadRoomMessages, loadPublicRooms } = useDashboard();

  if (state.publicRoomsLoading) {
    return (
      <div className="p-4 text-center text-xs text-text-secondary animate-pulse">
        Loading rooms...
      </div>
    );
  }

  if (state.publicRooms.length === 0) {
    return (
      <div className="p-4 text-center text-xs text-text-secondary">
        No public rooms yet
      </div>
    );
  }

  const handleSelect = (roomId: string) => {
    dispatch({ type: "SELECT_ROOM", roomId });
    if (!state.messages[roomId]) {
      loadRoomMessages(roomId);
    }
  };

  return (
    <div className="py-1">
      {state.publicRooms.map((room) => {
        const isSelected = state.selectedRoomId === room.room_id;
        return (
          <button
            key={room.room_id}
            onClick={() => handleSelect(room.room_id)}
            className={`w-full px-4 py-2.5 text-left transition-colors ${
              isSelected
                ? "bg-neon-cyan/10 border-l-2 border-neon-cyan"
                : "hover:bg-glass-bg border-l-2 border-transparent"
            }`}
          >
            <div className="flex items-center justify-between">
              <span className={`truncate text-sm font-medium ${isSelected ? "text-neon-cyan" : "text-text-primary"}`}>
                {room.name}
              </span>
              <span className="ml-2 shrink-0 text-xs text-text-secondary">
                {room.member_count}
              </span>
            </div>
            <p className="mt-0.5 truncate font-mono text-[10px] text-text-secondary/50">
              {room.room_id}
            </p>
            {room.description && (
              <p className="mt-0.5 truncate text-xs text-text-secondary">
                {room.description}
              </p>
            )}
            {room.last_message_preview && (
              <p className="mt-0.5 truncate text-xs text-text-secondary/60">
                {room.last_sender_name && (
                  <span className="text-text-primary/70">{room.last_sender_name}: </span>
                )}
                {room.last_message_preview}
              </p>
            )}
          </button>
        );
      })}
      <button
        onClick={loadPublicRooms}
        className="w-full py-2 text-xs text-text-secondary hover:text-neon-cyan"
      >
        Refresh
      </button>
    </div>
  );
}
