"use client";

import { useEffect, useRef } from "react";
import { useDashboardChatStore } from "@/store/useDashboardChatStore";
import { useDashboardSessionStore } from "@/store/useDashboardSessionStore";
import { useDashboardUIStore } from "@/store/useDashboardUIStore";

const MESSAGES_DIRECTORY_SYNC_INTERVAL_MS = 30_000;

/** Refresh on entry and resume; keep polling as a fallback for missed events. */
export function useMessagesPaneSync(enabled: boolean, sessionKey: string | null) {
  const lastDirectorySyncRef = useRef(0);
  useEffect(() => {
    if (!enabled) {
      return;
    }

    let cancelled = false;
    let syncInFlight = false;

    const syncMessagesPane = async (opts?: { forceDirectory?: boolean }) => {
      if (cancelled || syncInFlight) return;
      syncInFlight = true;
      try {
        const { openedRoomId, messagesPane } = useDashboardUIStore.getState();
        const session = useDashboardSessionStore.getState();
        const chat = useDashboardChatStore.getState();
        const now = Date.now();
        const shouldSyncDirectory = Boolean(opts?.forceDirectory)
          || now - lastDirectorySyncRef.current >= MESSAGES_DIRECTORY_SYNC_INTERVAL_MS;
        if (shouldSyncDirectory) {
          lastDirectorySyncRef.current = now;
        }
        const directorySync = shouldSyncDirectory ? [
          chat.refreshOverview(),
          session.human?.human_id ? session.refreshHumanRooms() : Promise.resolve(),
          session.activeIdentity?.type === "human" ? chat.loadOwnedAgentRooms() : Promise.resolve(),
        ] : [];
        await Promise.all([
          ...directorySync,
          openedRoomId && messagesPane === "room"
            ? chat.pollNewMessages(openedRoomId)
            : Promise.resolve(),
        ]);
      } finally {
        syncInFlight = false;
      }
    };

    void syncMessagesPane({ forceDirectory: true });

    const intervalId = window.setInterval(syncMessagesPane, 5_000);
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void syncMessagesPane({ forceDirectory: true });
      }
    };
    const handleFocus = () => {
      void syncMessagesPane({ forceDirectory: true });
    };
    window.addEventListener("focus", handleFocus);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
      window.removeEventListener("focus", handleFocus);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [enabled, sessionKey]);
}
