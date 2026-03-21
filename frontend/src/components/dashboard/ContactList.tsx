"use client";

import { useLanguage } from '@/lib/i18n';
import { contactList } from '@/lib/i18n/translations/dashboard';
import CopyableId from "@/components/ui/CopyableId";
import { useShallow } from "zustand/react/shallow";
import { useDashboardChatStore } from "@/store/useDashboardChatStore";

export default function ContactList() {
  const locale = useLanguage();
  const t = contactList[locale];
  const { overview, selectAgent } = useDashboardChatStore(useShallow((state) => ({
    overview: state.overview,
    selectAgent: state.selectAgent,
  })));
  const contacts = overview?.contacts || [];

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
          <div className="text-sm font-medium text-text-primary">
            {contact.alias || contact.display_name}
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
