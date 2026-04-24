"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { useLanguage } from "@/lib/i18n";
import { dmSettingsModal } from "@/lib/i18n/translations/dashboard";
import { api } from "@/lib/api";
import CopyableId from "@/components/ui/CopyableId";
import type { ContactInfo } from "@/lib/types";

interface DMSettingsModalProps {
  /** The contact on the other side of this DM. null when chatting with own agent. */
  contact: ContactInfo | null;
  /** Display name for own agent (used when contact is null). */
  ownAgentName?: string;
  /** Agent ID for own agent (used when contact is null). */
  ownAgentId?: string;
  onClose: () => void;
  /** Called after the contact has been successfully removed. */
  onContactRemoved?: () => void;
}

export default function DMSettingsModal({
  contact,
  ownAgentName,
  ownAgentId,
  onClose,
  onContactRemoved,
}: DMSettingsModalProps) {
  const locale = useLanguage();
  const t = dmSettingsModal[locale];
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const isOwnAgent = contact === null;
  const title = isOwnAgent ? t.titleMyAgent : t.titleFriend;

  const handleRemove = async () => {
    if (!contact) return;
    if (!confirming) {
      setConfirming(true);
      return;
    }
    setRemoving(true);
    setError(null);
    try {
      await api.removeContact(contact.contact_agent_id);
      onContactRemoved?.();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : t.removeFriendFailed);
      setConfirming(false);
    } finally {
      setRemoving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4" onClick={onClose}>
      <div
        className="flex max-h-[90vh] w-full max-w-sm flex-col overflow-hidden rounded-xl border border-glass-border bg-deep-black"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-glass-border px-6 py-4">
          <h2 className="text-lg font-semibold text-text-primary">{title}</h2>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
          {error && (
            <div className="rounded border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-400">
              {error}
            </div>
          )}

          {isOwnAgent ? (
            <div className="space-y-3">
              <div>
                <p className="mb-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-text-secondary/70">
                  {t.displayName}
                </p>
                <p className="text-sm text-text-primary">{ownAgentName ?? "—"}</p>
              </div>
              <div>
                <p className="mb-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-text-secondary/70">
                  {t.agentId}
                </p>
                <CopyableId id={ownAgentId ?? ""} />
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <div>
                <p className="mb-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-text-secondary/70">
                  {t.displayName}
                </p>
                <p className="text-sm text-text-primary">{contact!.display_name}</p>
              </div>
              <div>
                <p className="mb-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-text-secondary/70">
                  {t.agentId}
                </p>
                <CopyableId id={contact!.contact_agent_id} />
              </div>
            </div>
          )}
        </div>

        <div className="flex justify-between gap-2 border-t border-glass-border px-6 py-3">
          {!isOwnAgent && (
            <button
              onClick={() => void handleRemove()}
              disabled={removing}
              className="inline-flex items-center gap-1.5 rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-400 hover:bg-red-500/20 disabled:opacity-50"
            >
              {removing && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {confirming
                ? removing ? t.removingFriend : t.removeFriendConfirm
                : t.removeFriend}
            </button>
          )}
          <button
            onClick={onClose}
            className="ml-auto rounded border border-glass-border px-4 py-2 text-sm text-text-secondary hover:text-text-primary"
          >
            {t.close}
          </button>
        </div>
      </div>
    </div>
  );
}
