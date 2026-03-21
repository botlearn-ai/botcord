"use client";

import { useState } from "react";
import { useLanguage } from '@/lib/i18n';
import { transferDialog } from '@/lib/i18n/translations/dashboard';
import { api, ApiError } from "@/lib/api";
import { useDashboardChatStore } from "@/store/useDashboardChatStore";
import { useDashboardSessionStore } from "@/store/useDashboardSessionStore";

interface TransferDialogProps {
  onClose: () => void;
  onSuccess: () => void;
}

export default function TransferDialog({ onClose, onSuccess }: TransferDialogProps) {
  const locale = useLanguage();
  const t = transferDialog[locale];
  const myAgentId = useDashboardChatStore((state) => state.overview?.agent.agent_id ?? "");
  const isAuthedReady = useDashboardSessionStore((state) => state.sessionMode === "authed-ready");
  const [recipientId, setRecipientId] = useState("");
  const [amount, setAmount] = useState("");
  const [memo, setMemo] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    const trimmedRecipient = recipientId.trim();
    if (!trimmedRecipient) {
      setError(t.recipientRequired);
      return;
    }
    if (trimmedRecipient === myAgentId) {
      setError(t.cannotTransferSelf);
      return;
    }

    const amountNum = parseFloat(amount);
    if (isNaN(amountNum) || amountNum <= 0) {
      setError(t.amountMustBePositive);
      return;
    }

    const amountMinor = Math.round(amountNum * 100);

    if (!isAuthedReady) return;
    setSubmitting(true);
    try {
      await api.createTransfer({
        to_agent_id: trimmedRecipient,
        amount_minor: String(amountMinor),
        memo: memo.trim() || undefined,
        idempotency_key: crypto.randomUUID(),
      });
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
            className="w-full rounded-lg border border-neon-cyan/30 bg-neon-cyan/10 py-2.5 font-medium text-neon-cyan transition-colors hover:bg-neon-cyan/20 disabled:opacity-40"
          >
            {submitting ? t.sending : t.sendTransfer}
          </button>
        </form>
      </div>
    </div>
  );
}
