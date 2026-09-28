"use client";

/**
 * Team conversation pane: an organization room rendered with the shared
 * personal-chat building blocks (RoomHeader + MessageList + RoomHumanComposer).
 * Those components read the opened room from the dashboard UI store, so this
 * pane claims `openedRoomId` while mounted and polls messages itself (the
 * personal 5s poll is off in Team mode).
 */
import { useEffect } from "react";
import { useLanguage } from "@/lib/i18n";
import RoomHeader from "@/components/dashboard/RoomHeader";
import MessageList from "@/components/dashboard/MessageList";
import RoomHumanComposer from "@/components/dashboard/RoomHumanComposer";
import { useDashboardChatStore } from "@/store/useDashboardChatStore";
import { useDashboardUIStore } from "@/store/useDashboardUIStore";

export const TEAM_ROOM_POLL_MS = 5000;

export default function TeamRoomPane({
  roomId,
  title,
  allowHumanSend,
  onBack,
  onOpenMembers,
}: {
  roomId: string;
  title: string;
  allowHumanSend: boolean;
  onBack: () => void;
  onOpenMembers: () => void;
}) {
  const zh = useLanguage() === "zh";
  const opened = useDashboardUIStore((s) => s.openedRoomId === roomId);

  useEffect(() => {
    const ui = useDashboardUIStore.getState();
    ui.setMessagesPane("room");
    ui.setFocusedRoomId(roomId);
    ui.setOpenedRoomId(roomId);
    const chat = useDashboardChatStore.getState();
    if (Object.prototype.hasOwnProperty.call(chat.messages, roomId)) void chat.pollNewMessages(roomId);
    const poll = () => {
      if (document.visibilityState === "visible") void useDashboardChatStore.getState().pollNewMessages(roomId);
    };
    const timer = window.setInterval(poll, TEAM_ROOM_POLL_MS);
    document.addEventListener("visibilitychange", poll);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", poll);
      const current = useDashboardUIStore.getState();
      if (current.openedRoomId === roomId) current.setOpenedRoomId(null);
      if (current.focusedRoomId === roomId) current.setFocusedRoomId(null);
    };
  }, [roomId]);

  return (
    <div className="dashboard-main flex h-full min-h-0 flex-col overflow-hidden bg-deep-black" data-team-room={roomId}>
      <RoomHeader
        onBack={onBack}
        title={title}
        onOpenMembers={onOpenMembers}
        membersLabel={zh ? "成员与 Agent" : "Members & Agents"}
      />
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {opened && <MessageList key={roomId} />}
      </div>
      <div className="shrink-0 border-t border-glass-border px-4 py-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))] max-md:px-2">
        {allowHumanSend ? (
          <RoomHumanComposer roomId={roomId} />
        ) : (
          <p className="text-center text-xs text-text-secondary/60">
            {zh ? "该房间暂不允许成员发言" : "Members can't send messages in this room"}
          </p>
        )}
      </div>
    </div>
  );
}
