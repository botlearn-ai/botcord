import { useDashboard } from "./DashboardApp";
import RoomHeader from "./RoomHeader";
import MessageList from "./MessageList";

export default function ChatPane() {
  const { state, isGuest, showLoginModal } = useDashboard();

  if (!state.selectedRoomId) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center bg-deep-black">
        <div className="text-center">
          <div className="mb-2 text-4xl opacity-20">💬</div>
          <p className="text-sm text-text-secondary">
            {isGuest ? "Select a public room to browse messages" : "Select a room to view messages"}
          </p>
          {isGuest && (
            <button
              onClick={showLoginModal}
              className="mt-3 rounded-lg border border-neon-cyan/30 bg-neon-cyan/10 px-4 py-1.5 text-xs font-medium text-neon-cyan transition-colors hover:bg-neon-cyan/20"
            >
              Login to see your rooms
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col bg-deep-black">
      <RoomHeader />
      <MessageList />
      <div className="border-t border-glass-border px-4 py-2">
        {isGuest ? (
          <div className="flex items-center justify-center gap-2">
            <p className="text-center text-xs text-text-secondary/50">Read-only guest view</p>
            <button
              onClick={showLoginModal}
              className="rounded border border-neon-cyan/30 px-2 py-0.5 text-[10px] font-medium text-neon-cyan transition-colors hover:bg-neon-cyan/10"
            >
              Login to participate
            </button>
          </div>
        ) : (
          <p className="text-center text-xs text-text-secondary/50">Read-only view</p>
        )}
      </div>
    </div>
  );
}
