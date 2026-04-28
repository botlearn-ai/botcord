"use client";

import { useLanguage } from '@/lib/i18n';
import { contactList } from '@/lib/i18n/translations/dashboard';
import CopyableId from "@/components/ui/CopyableId";
import { useShallow } from "zustand/react/shallow";
import { useEffect } from "react";
import { useDashboardChatStore } from "@/store/useDashboardChatStore";
import { useDashboardUIStore } from "@/store/useDashboardUIStore";
import { usePresenceStore } from "@/store/usePresenceStore";
import { PresenceDot } from "./PresenceDot";
import { initialsFromName } from "./roomVisualTheme";

export default function ContactList() {
  const locale = useLanguage();
  const t = contactList[locale];
  const { overview, selectAgent } = useDashboardChatStore(useShallow((state) => ({
    overview: state.overview,
    selectAgent: state.selectAgent,
  })));
  const requestOpenHuman = useDashboardUIStore((state) => state.requestOpenHuman);
  const contacts = overview?.contacts || [];

  useEffect(() => {
    if (contacts.length === 0) return;
    usePresenceStore.getState().seed(
      contacts.map((c) => ({ agentId: c.contact_agent_id, online: Boolean(c.online) })),
    );
  }, [contacts]);

  if (contacts.length === 0) {
    return (
      <div className="p-4 text-center text-xs text-text-secondary">
        {t.noContacts}
      </div>
    );
  }

  return (
    <div className="py-1">
      {contacts.map((contact) => {
        const isHuman = contact.peer_type === "human" || contact.contact_agent_id.startsWith("hu_");
        const primaryName = contact.alias || contact.display_name;
        const hasRealName = primaryName && primaryName !== contact.contact_agent_id;
        const displayLabel = hasRealName ? primaryName : (isHuman ? t.unnamedHuman : t.unnamedAgent);
        const initials = initialsFromName(hasRealName ? primaryName : contact.contact_agent_id);
        const avatarBorder = isHuman ? "border-neon-green/30" : "border-neon-cyan/30";
        const avatarFallback = isHuman
          ? "border-neon-green/30 bg-neon-green/10 text-neon-green"
          : "border-neon-cyan/30 bg-neon-cyan/10 text-neon-cyan";
        return (
          <button
            key={contact.contact_agent_id}
            onClick={() => {
              if (isHuman) {
                requestOpenHuman(contact.contact_agent_id, displayLabel);
              } else {
                void selectAgent(contact.contact_agent_id);
              }
            }}
            className="w-full px-4 py-2.5 text-left transition-colors hover:bg-glass-bg border-l-2 border-transparent"
          >
            <div className="flex items-center gap-2.5">
              {contact.avatar_url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={contact.avatar_url}
                  alt={displayLabel}
                  className={`h-8 w-8 shrink-0 rounded-full border object-cover ${avatarBorder}`}
                />
              ) : (
                <div
                  className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full border text-[11px] font-semibold ${avatarFallback}`}
                >
                  {initials}
                </div>
              )}
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 text-sm font-medium text-text-primary">
                  <PresenceDot agentId={contact.contact_agent_id} fallback={contact.online} />
                  <span className="truncate">{displayLabel}</span>
                </div>
                <CopyableId value={contact.contact_agent_id} className="mt-0.5" />
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );
}
