"use client";

import { useState } from "react";
import { useDashboard } from "./DashboardApp";
import { useLanguage } from '@/lib/i18n';
import { withdrawDialog } from '@/lib/i18n/translations/dashboard';
import { api, ApiError } from "@/lib/api";

interface WithdrawDialogProps {
  onClose: () => void;
  onSuccess: () => void;
  availableBalance: string;
}

function formatCoinAmount(minorStr: string): string {
  const minor = parseInt(minorStr, 10);
  if (isNaN(minor)) return "0.00";
  const major = minor / 100;
  return major.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export default function WithdrawDialog({ onClose, onSuccess, availableBalance }: WithdrawDialogProps) {
  const { state } = useDashboard();
  const locale = useLanguage();
  const t = withdrawDialog[locale];
  const [amount, setAmount] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const availableMinor = parseInt(availableBalance, 10) || 0;
  const availableMajor = availableMinor / 100;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    const amountNum = parseFloat(amount);
    if (isNaN(amountNum) || amountNum <= 0) {
      setError(t.amountMustBePositive);
      return;
    }

    const amountMinor = Math.round(amountNum * 100);
    if (amountMinor > availableMinor) {
      setError(`${t.amountExceedsBalance} (${formatCoinAmount(availableBalance)})`);
      return;
    }

    if (!state.token) return;
    setSubmitting(true);
    try {
      await api.createWithdrawal({
        amount_minor: String(amountMinor),
        destination_type: "mock_bank",
        destination: {
          account_name: "Mock Account",
          account_no: "****0000",
        },
        idempotency_key: crypto.randomUUID(),
      });
      onSuccess();
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError(t.withdrawFailed);
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
          <h3 className="text-lg font-semibold text-text-primary">{t.withdraw}</h3>
          <p className="text-xs text-text-secondary">{t.requestWithdraw}</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="rounded-lg border border-glass-border bg-deep-black-light p-3">
            <div className="flex items-center justify-between">
              <span className="text-xs text-text-secondary">{t.availableBalance}</span>
              <span className="font-mono text-sm font-semibold text-neon-green">
                {formatCoinAmount(availableBalance)}
              </span>
            </div>
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-text-secondary">
              {t.amountCoin}
            </label>
            <input
              type="number"
              step="0.01"
              min="0.01"
              max={availableMajor}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.00"
              className="w-full rounded-lg border border-glass-border bg-deep-black-light p-3 font-mono text-sm text-text-primary placeholder-text-secondary/50 outline-none focus:border-neon-purple/50"
            />
            <button
              type="button"
              onClick={() => setAmount(String(availableMajor))}
              className="mt-1 text-[10px] text-neon-purple hover:underline"
            >
              {t.withdrawAll}
            </button>
          </div>

          {error && <p className="text-sm text-red-400">{error}</p>}

          <button
            type="submit"
            disabled={submitting}
            className="w-full rounded-lg border border-neon-purple/30 bg-neon-purple/10 py-2.5 font-medium text-neon-purple transition-colors hover:bg-neon-purple/20 disabled:opacity-40"
          >
            {submitting ? t.submitting : t.submitWithdraw}
          </button>
        </form>
      </div>
    </div>
  );
}
