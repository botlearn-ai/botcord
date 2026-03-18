"use client";

import { useDashboard } from "./DashboardApp";
import { useLanguage } from '@/lib/i18n';
import { roomList } from '@/lib/i18n/translations/dashboard';

export default function RoomList() {
  const { state, dispatch, loadRoomMessages } = useDashboard();
  const locale = useLanguage();
  const t = roomList[locale];
  const rooms = state.overview?.rooms || [];

  const handleSelect = (roomId: string) => {
    dispatch({ type: "SELECT_ROOM", roomId });
    if (!state.messages[roomId]) {
      loadRoomMessages(roomId);
    }
  };

  if (rooms.length === 0) {
    return (
      <div className="p-4 text-center text-xs text-text-secondary">
        {t.noRooms}
      </div>
    );
  }

  return (
    <div className="py-1">
      {rooms.map((room) => {
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
            {room.last_message_preview && (
              <p className="mt-0.5 truncate text-xs text-text-secondary">
                {room.last_sender_name && (
                  <span className="text-text-primary/70">{room.last_sender_name}: </span>
                )}
                {room.last_message_preview}
              </p>
            )}
            {room.last_message_at && (
              <p className="mt-0.5 font-mono text-[10px] text-text-secondary/60">
                {new Date(room.last_message_at).toLocaleString()}
              </p>
            )}
          </button>
        );
      })}
    </div>
  );
}
