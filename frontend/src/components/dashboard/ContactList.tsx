"use client";

import { useLanguage } from '@/lib/i18n';
import { contactList } from '@/lib/i18n/translations/dashboard';
import CopyableId from "@/components/ui/CopyableId";
import { useShallow } from "zustand/react/shallow";
import { useEffect } from "react";
import { useDashboardChatStore } from "@/store/useDashboardChatStore";
import { usePresenceStore } from "@/store/usePresenceStore";
import { PresenceDot } from "./PresenceDot";

export default function ContactList() {
  const locale = useLanguage();
  const t = contactList[locale];
  const { overview, selectAgent } = useDashboardChatStore(useShallow((state) => ({
    overview: state.overview,
    selectAgent: state.selectAgent,
  })));
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
      {contacts.map((contact) => (
        <button
          key={contact.contact_agent_id}
          onClick={() => selectAgent(contact.contact_agent_id)}
          className="w-full px-4 py-2.5 text-left transition-colors hover:bg-glass-bg border-l-2 border-transparent"
        >
          <div className="flex items-center gap-2 text-sm font-medium text-text-primary">
            <PresenceDot agentId={contact.contact_agent_id} fallback={contact.online} />
            <span>{contact.alias || contact.display_name}</span>
          </div>
          {contact.alias && (
            <div className="text-xs text-text-secondary">{contact.display_name}</div>
          )}
          <CopyableId value={contact.contact_agent_id} className="mt-0.5" />
        </button>
      ))}
    </div>
  );
}
