"use client";

import { useDashboard } from "./DashboardApp";
import { useLanguage } from '@/lib/i18n';
import { chatPane } from '@/lib/i18n/translations/dashboard';
import { common } from '@/lib/i18n/translations/common';
import RoomHeader from "./RoomHeader";
import MessageList from "./MessageList";

export default function ChatPane() {
  const { state, isGuest, showLoginModal } = useDashboard();
  const locale = useLanguage();
  const t = chatPane[locale];
  const tc = common[locale];

  if (!state.selectedRoomId) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center bg-deep-black">
        <div className="text-center">
          <div className="mb-2 text-4xl opacity-20">💬</div>
          <p className="text-sm text-text-secondary">
            {isGuest ? t.selectPublicRoom : t.selectRoom}
          </p>
          {isGuest && (
            <button
              onClick={showLoginModal}
              className="mt-3 rounded-lg border border-neon-cyan/30 bg-neon-cyan/10 px-4 py-1.5 text-xs font-medium text-neon-cyan transition-colors hover:bg-neon-cyan/20"
            >
              {t.loginToSee}
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
            <p className="text-center text-xs text-text-secondary/50">{t.readOnlyGuest}</p>
            <button
              onClick={showLoginModal}
              className="rounded border border-neon-cyan/30 px-2 py-0.5 text-[10px] font-medium text-neon-cyan transition-colors hover:bg-neon-cyan/10"
            >
              {t.loginToParticipate}
            </button>
          </div>
        ) : (
          <p className="text-center text-xs text-text-secondary/50">{t.readOnlyView}</p>
        )}
      </div>
    </div>
  );
}
