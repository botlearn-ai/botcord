"use client";

import { Loader2, X } from "lucide-react";
import { useLanguage } from "@/lib/i18n";
import { roomAdvancedSettings } from "@/lib/i18n/translations/dashboard";

interface PlanChangeConfirmDialogProps {
  fromLabel: string;
  toLabel: string;
  affectedCount: number;
  loading?: boolean;
  onClose: () => void;
  onConfirm: () => void;
}

export default function PlanChangeConfirmDialog({
  fromLabel,
  toLabel,
  affectedCount,
  loading = false,
  onClose,
  onConfirm,
}: PlanChangeConfirmDialogProps) {
  const locale = useLanguage();
  const ta = roomAdvancedSettings[locale];

  const fromTo = ta.planChangeFromTo
    .replace("{from}", fromLabel)
    .replace("{to}", toLabel);
  const warning = ta.planChangeWarning.replace(
    "{count}",
    String(affectedCount),
  );

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="relative w-full max-w-md rounded-2xl border border-glass-border bg-deep-black-light p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={onClose}
          disabled={loading}
          className="absolute right-4 top-4 rounded-full p-1.5 text-text-secondary transition-colors hover:bg-glass-bg hover:text-text-primary disabled:opacity-50"
          aria-label={ta.planChangeCancel}
        >
          <X className="h-5 w-5" />
        </button>

        <div className="pr-8">
          <h3 className="text-xl font-bold text-text-primary">{ta.planChangeTitle}</h3>
          <p className="mt-3 text-sm text-text-primary/90">{fromTo}</p>
          {affectedCount > 0 ? (
            <p className="mt-3 rounded-lg border border-yellow-500/30 bg-yellow-500/10 px-3 py-2 text-xs text-yellow-200">
              ⚠️ {warning}
            </p>
          ) : null}
          <p className="mt-3 text-xs text-text-secondary">{ta.planChangeIrreversible}</p>
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={loading}
            className="rounded-lg border border-glass-border px-3 py-1.5 text-sm text-text-secondary transition-colors hover:bg-glass-bg disabled:opacity-50"
          >
            {ta.planChangeCancel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={loading}
            className="inline-flex items-center gap-1.5 rounded-lg border border-neon-cyan/40 bg-neon-cyan/10 px-3 py-1.5 text-sm font-medium text-neon-cyan transition-colors hover:bg-neon-cyan/20 disabled:opacity-50"
          >
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            {ta.planChangeConfirm}
          </button>
        </div>
      </div>
    </div>
  );
}
