import type { DashboardRoom } from "./types";

export function canPrefetchMessagePage(roomId: string): boolean {
  return !roomId.startsWith("rm_oc_pending_");
}

export function messagePrefetchCandidates(rooms: DashboardRoom[]): DashboardRoom[] {
  return rooms
    .filter((room) => canPrefetchMessagePage(room.room_id) && (room.last_message_at || room.has_unread))
    .slice()
    .sort((a, b) => {
      const unreadDelta = Number(Boolean(b.has_unread)) - Number(Boolean(a.has_unread));
      if (unreadDelta !== 0) return unreadDelta;
      return (Date.parse(b.last_message_at || "") || 0) - (Date.parse(a.last_message_at || "") || 0);
    })
    .slice(0, 6);
}

// Keep speculative history requests from occupying every connection when the
// reader opens a different conversation. Cancellation stops queued work.
export function prefetchMessagePages(
  rooms: DashboardRoom[],
  prefetch: (roomId: string) => Promise<void>,
): () => void {
  let cancelled = false;
  let next = 0;
  const run = async () => {
    while (!cancelled && next < rooms.length) {
      const room = rooms[next++];
      try {
        await prefetch(room.room_id);
      } catch {
        // A speculative failure must not prevent opening other conversations.
      }
    }
  };
  void run();
  void run();
  return () => { cancelled = true; };
}
