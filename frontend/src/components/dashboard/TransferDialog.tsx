"use client";

import { useMemo, useState } from "react";
import { useLanguage } from '@/lib/i18n';
import { transferDialog } from '@/lib/i18n/translations/dashboard';
import { api, ApiError, type ActiveIdentity } from "@/lib/api";
import { useDashboardChatStore } from "@/store/useDashboardChatStore";
import { useDashboardSessionStore } from "@/store/useDashboardSessionStore";
import { useShallow } from "zustand/react/shallow";
import { Loader2 } from "lucide-react";

interface TransferDialogProps {
  /**
   * Identity that owns the wallet sending the transfer. ``null`` follows the
   * global active identity. The picker excludes this id so users can't
   * select the source as the recipient.
   */
  viewer?: ActiveIdentity | null;
  onClose: () => void;
  onSuccess: () => void;
}

interface RecipientOption {
  /** Stable key for <option> elements (group + id). */
  key: string;
  /** Display label rendered inline. */
  label: string;
  /** Owner id — `ag_*` or `hu_*`. Backend ``_assert_owner_exists`` accepts both. */
  id: string;
}

export default function TransferDialog({ viewer, onClose, onSuccess }: TransferDialogProps) {
  const locale = useLanguage();
  const t = transferDialog[locale];

  const sessionStore = useDashboardSessionStore(
    useShallow((s) => ({
      activeIdentity: s.activeIdentity,
      ownedAgents: s.ownedAgents,
      human: s.human,
      sessionMode: s.sessionMode,
    })),
  );
  const contacts = useDashboardChatStore((s) => s.overview?.contacts) ?? [];

  const senderIdentity: ActiveIdentity | null = viewer ?? sessionStore.activeIdentity;
  const senderId = senderIdentity?.id ?? "";

  // Build grouped recipient options. Backend transfer accepts agent and
  // human owner ids interchangeably, so all three categories live in a
  // single picker with optgroup labels.
  const ownedBotOptions: RecipientOption[] = useMemo(() => {
    return sessionStore.ownedAgents
      .filter((a) => a.agent_id !== senderId)
      .map((a) => ({
        key: `bot:${a.agent_id}`,
        label: `${a.display_name} · ${a.agent_id}`,
        id: a.agent_id,
      }));
  }, [sessionStore.ownedAgents, senderId]);

  const humanSelfOption: RecipientOption | null = useMemo(() => {
    if (!sessionStore.human?.human_id) return null;
    if (sessionStore.human.human_id === senderId) return null;
    return {
      key: `human:${sessionStore.human.human_id}`,
      label: `${sessionStore.human.display_name} · ${sessionStore.human.human_id}`,
      id: sessionStore.human.human_id,
    };
  }, [sessionStore.human, senderId]);

  const contactOptions: RecipientOption[] = useMemo(() => {
    return contacts
      .filter((c) => c.contact_agent_id !== senderId)
      .map((c) => ({
        key: `contact:${c.contact_agent_id}`,
        label: `${c.alias ?? c.display_name} · ${c.contact_agent_id}`,
        id: c.contact_agent_id,
      }));
  }, [contacts, senderId]);

  const isAuthed = sessionStore.sessionMode !== "guest";
  const [recipientId, setRecipientId] = useState("");
  const [amount, setAmount] = useState("");
  const [memo, setMemo] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const handlePickRecipient = (value: string) => {
    if (!value) return;
    setRecipientId(value);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    const trimmedRecipient = recipientId.trim();
    if (!trimmedRecipient) {
      setError(t.recipientRequired);
      return;
    }
    if (trimmedRecipient === senderId) {
      setError(t.cannotTransferSelf);
      return;
    }

    const amountNum = parseFloat(amount);
    if (isNaN(amountNum) || amountNum <= 0) {
      setError(t.amountMustBePositive);
      return;
    }

    const amountMinor = Math.round(amountNum * 100);

    if (!isAuthed) return;
    setSubmitting(true);
    try {
      await api.createTransfer({
        to_agent_id: trimmedRecipient,
        amount_minor: String(amountMinor),
        memo: memo.trim() || undefined,
        idempotency_key: crypto.randomUUID(),
      }, viewer);
      onSuccess();
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError(t.transferFailed);
      }
    } finally {
      setSubmitting(false);
    }
  };

  const hasShortcuts =
    humanSelfOption !== null || ownedBotOptions.length > 0 || contactOptions.length > 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="relative w-full max-w-md rounded-2xl border border-glass-border bg-glass-bg p-6 backdrop-blur-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={onClose}
          className="absolute right-4 top-4 rounded p-1 text-text-secondary hover:text-text-primary"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M4 4l8 8M12 4l-8 8" />
          </svg>
        </button>

        <div className="mb-5">
          <h3 className="text-lg font-semibold text-text-primary">{t.transfer}</h3>
          <p className="text-xs text-text-secondary">{t.sendCoins}</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {hasShortcuts ? (
            <div>
              <label className="mb-1 block text-xs font-medium text-text-secondary">
                {t.pickRecipient}
              </label>
              <select
                value={recipientId}
                onChange={(e) => handlePickRecipient(e.target.value)}
                className="w-full rounded-lg border border-glass-border bg-deep-black-light p-3 text-sm text-text-primary outline-none focus:border-neon-cyan/50"
              >
                <option value="">{t.pickRecipientDefault}</option>
                {humanSelfOption ? (
                  <optgroup label={t.groupHumanSelf}>
                    <option value={humanSelfOption.id}>{humanSelfOption.label}</option>
                  </optgroup>
                ) : null}
                {ownedBotOptions.length > 0 ? (
                  <optgroup label={t.groupMyBots}>
                    {ownedBotOptions.map((o) => (
                      <option key={o.key} value={o.id}>{o.label}</option>
                    ))}
                  </optgroup>
                ) : null}
                {contactOptions.length > 0 ? (
                  <optgroup label={t.groupContacts}>
                    {contactOptions.map((o) => (
                      <option key={o.key} value={o.id}>{o.label}</option>
                    ))}
                  </optgroup>
                ) : null}
              </select>
            </div>
          ) : null}

          <div>
            <label className="mb-1 block text-xs font-medium text-text-secondary">
              {t.recipientAgentId}
            </label>
            <input
              type="text"
              value={recipientId}
              onChange={(e) => setRecipientId(e.target.value)}
              placeholder={t.recipientPlaceholder}
              className="w-full rounded-lg border border-glass-border bg-deep-black-light p-3 font-mono text-sm text-text-primary placeholder-text-secondary/50 outline-none focus:border-neon-cyan/50"
            />
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-text-secondary">
              {t.amountCoin}
            </label>
            <input
              type="number"
              step="0.01"
              min="0.01"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.00"
              className="w-full rounded-lg border border-glass-border bg-deep-black-light p-3 font-mono text-sm text-text-primary placeholder-text-secondary/50 outline-none focus:border-neon-cyan/50"
            />
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-text-secondary">
              {t.memoOptional}
            </label>
            <input
              type="text"
              value={memo}
              onChange={(e) => setMemo(e.target.value)}
              placeholder={t.memoPlaceholder}
              className="w-full rounded-lg border border-glass-border bg-deep-black-light p-3 text-sm text-text-primary placeholder-text-secondary/50 outline-none focus:border-neon-cyan/50"
            />
          </div>

          {error && <p className="text-sm text-red-400">{error}</p>}

          <button
            type="submit"
            disabled={submitting}
            className="inline-flex w-full items-center justify-center gap-2 rounded-lg border border-neon-cyan/30 bg-neon-cyan/10 py-2.5 font-medium text-neon-cyan transition-colors hover:bg-neon-cyan/20 disabled:opacity-40"
          >
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {submitting ? t.sending : t.sendTransfer}
          </button>
        </form>
      </div>
    </div>
  );
}
