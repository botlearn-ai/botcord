import { useState, useEffect } from "react";
import { useDashboard } from "./DashboardApp";
import ShareModal from "./ShareModal";
import CopyableId from "../ui/CopyableId";
import type { PublicRoomMember } from "../../lib/types";
import { api } from "../../lib/api";

export default function RoomHeader() {
  const { state, isGuest, selectAgent } = useDashboard();
  const [showShareModal, setShowShareModal] = useState(false);
  const [showMembers, setShowMembers] = useState(false);
  const [members, setMembers] = useState<PublicRoomMember[]>([]);
  const [membersLoading, setMembersLoading] = useState(false);

  // Auth mode: find room from overview
  const authRoom = state.overview?.rooms.find((r) => r.room_id === state.selectedRoomId);
  // Guest mode: find room from public rooms
  const publicRoom = state.publicRooms.find((r) => r.room_id === state.selectedRoomId);

  const room = authRoom || publicRoom;

  // Reset members panel when room changes
  useEffect(() => {
    setShowMembers(false);
    setMembers([]);
  }, [state.selectedRoomId]);

  const handleToggleMembers = async () => {
    if (showMembers) {
      setShowMembers(false);
      return;
    }
    if (!state.selectedRoomId) return;
    setShowMembers(true);
    if (members.length > 0) return;

    setMembersLoading(true);
    try {
      const result = await api.getPublicRoomMembers(state.selectedRoomId);
      setMembers(result.members);
    } catch (err) {
      console.error("[RoomHeader] Failed to load members:", err);
    } finally {
      setMembersLoading(false);
    }
  };

  if (!room) return null;

  return (
    <>
      <div className="flex items-center justify-between border-b border-glass-border px-4 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="truncate text-sm font-semibold text-text-primary">{room.name}</h3>
            <CopyableId value={room.room_id} />
          </div>
          <p className="text-xs text-text-secondary">
            <button
              onClick={handleToggleMembers}
              className="hover:text-neon-cyan hover:underline transition-colors"
            >
              {room.member_count} member{room.member_count !== 1 ? "s" : ""}
            </button>
            {room.description && <span className="ml-2 text-text-secondary/60">· {room.description}</span>}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {!isGuest && authRoom && (
            <>
              <span className="rounded border border-glass-border px-2 py-0.5 font-mono text-[10px] text-text-secondary">
                {authRoom.my_role}
              </span>
              <button
                onClick={() => setShowShareModal(true)}
                className="rounded p-1 text-text-secondary hover:bg-glass-bg hover:text-text-primary"
                title="Share room"
              >
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M4 8V12C4 12.5523 4.44772 13 5 13H11C11.5523 13 12 12.5523 12 12V8" />
                  <path d="M8 3V10" />
                  <path d="M5.5 5.5L8 3L10.5 5.5" />
                </svg>
              </button>
            </>
          )}
          {isGuest && (
            <span className="rounded border border-neon-purple/30 bg-neon-purple/10 px-2 py-0.5 text-[10px] font-medium text-neon-purple">
              Guest
            </span>
          )}
          {/* Members toggle */}
          <button
            onClick={handleToggleMembers}
            className={`rounded p-1 transition-colors ${showMembers ? "bg-neon-cyan/10 text-neon-cyan" : "text-text-secondary hover:bg-glass-bg hover:text-text-primary"}`}
            title="View members"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
              <circle cx="6" cy="5" r="2.5" />
              <path d="M1.5 14c0-2.5 2-4.5 4.5-4.5s4.5 2 4.5 4.5" />
              <circle cx="11.5" cy="5.5" r="1.8" />
              <path d="M11.5 9c1.8 0 3.2 1.2 3.5 3" />
            </svg>
          </button>
        </div>
      </div>

      {/* Members panel */}
      {showMembers && (
        <div className="border-b border-glass-border bg-deep-black-light px-4 py-2">
          <div className="mb-1.5 flex items-center justify-between">
            <h4 className="text-xs font-medium text-text-secondary">
              Members ({members.length || room.member_count})
            </h4>
            <button
              onClick={() => setShowMembers(false)}
              className="rounded p-0.5 text-text-secondary hover:text-text-primary"
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M2 2l8 8M10 2l-8 8" />
              </svg>
            </button>
          </div>
          {membersLoading ? (
            <p className="py-2 text-center text-xs text-text-secondary animate-pulse">Loading...</p>
          ) : members.length === 0 ? (
            <p className="py-2 text-center text-xs text-text-secondary">No members</p>
          ) : (
            <div className="max-h-48 overflow-y-auto">
              {members.map((m) => (
                <button
                  key={m.agent_id}
                  onClick={() => selectAgent(m.agent_id)}
                  className="flex w-full items-center justify-between rounded px-2 py-1.5 text-left transition-colors hover:bg-glass-bg"
                >
                  <div className="min-w-0">
                    <span className="text-xs font-medium text-text-primary">{m.display_name}</span>
                    <CopyableId value={m.agent_id} className="ml-1.5" />
                  </div>
                  <span className={`shrink-0 rounded border px-1.5 py-px text-[9px] font-medium ${
                    m.role === "owner"
                      ? "border-neon-cyan/30 text-neon-cyan"
                      : m.role === "admin"
                        ? "border-neon-purple/30 text-neon-purple"
                        : "border-glass-border text-text-secondary"
                  }`}>
                    {m.role}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {showShareModal && state.token && (
        <ShareModal
          roomId={room.room_id}
          roomName={room.name}
          token={state.token}
          onClose={() => setShowShareModal(false)}
        />
      )}
    </>
  );
}
