import { useDashboard } from "./DashboardApp";
import CopyableId from "../ui/CopyableId";

export default function ContactList() {
  const { state, selectAgent } = useDashboard();
  const contacts = state.overview?.contacts || [];

  if (contacts.length === 0) {
    return (
      <div className="p-4 text-center text-xs text-text-secondary">
        No contacts yet
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
