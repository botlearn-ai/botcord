"use client";

import { useState } from "react";
import { userApi } from "@/lib/api";
import { useLanguage } from "@/lib/i18n";
import { unbindAgentDialog } from "@/lib/i18n/translations/dashboard";
import { AlertTriangle, Loader2, Unlink, X } from "lucide-react";

interface UnbindAgentDialogProps {
  agentId: string;
  agentName: string;
  onClose: () => void;
  onUnbound: (agentId: string) => Promise<void> | void;
}

export default function UnbindAgentDialog({
  agentId,
  agentName,
  onClose,
  onUnbound,
}: UnbindAgentDialogProps) {
  const locale = useLanguage();
  const t = unbindAgentDialog[locale];
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleUnbind() {
    setLoading(true);
    setError(null);
    try {
      await userApi.unbindAgent(agentId);
      await onUnbound(agentId);
      onClose();
    } catch (err: any) {
      setError(err?.message || t.failed);
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
      <div className="relative w-full max-w-md rounded-2xl border border-glass-border bg-deep-black-light p-5 shadow-2xl">
        <button
          onClick={onClose}
          disabled={loading}
          className="absolute right-4 top-4 rounded-full p-1.5 text-text-secondary transition-colors hover:bg-glass-bg hover:text-text-primary disabled:opacity-50"
        >
          <X className="h-5 w-5" />
        </button>

        <div className="mb-5 pr-8">
          <h3 className="flex items-center gap-2 text-xl font-bold text-text-primary">
            <Unlink className="h-5 w-5 text-red-400" />
            {t.title}
          </h3>
          <p className="mt-2 text-sm text-text-secondary">{t.description}</p>
        </div>

        <div className="rounded-xl border border-amber-400/20 bg-amber-400/5 p-3">
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-400" />
            <p className="text-xs text-amber-300">{t.warning}</p>
          </div>
        </div>

        <p className="mt-4 text-xs text-text-secondary">
          {t.targetAgent}
          <span className="font-mono text-text-primary">{agentName}</span>
          <span className="ml-1 text-text-secondary/50">({agentId})</span>
        </p>

        {error && (
          <p className="mt-4 rounded-lg border border-red-400/20 bg-red-400/10 p-2 text-xs text-red-400">
            {error}
          </p>
        )}

        <div className="mt-6 flex items-center justify-end gap-3">
          <button
            onClick={onClose}
            disabled={loading}
            className="rounded-xl border border-glass-border px-4 py-2.5 text-sm font-medium text-text-secondary transition-colors hover:bg-glass-bg hover:text-text-primary disabled:opacity-50"
          >
            {t.cancel}
          </button>
          <button
            onClick={handleUnbind}
            disabled={loading}
            className="flex items-center gap-2 rounded-xl border border-red-400/50 bg-red-500/10 px-4 py-2.5 text-sm font-bold text-red-400 transition-all hover:bg-red-500/20 disabled:opacity-60"
          >
            {loading ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                {t.unbinding}
              </>
            ) : (
              t.confirm
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
