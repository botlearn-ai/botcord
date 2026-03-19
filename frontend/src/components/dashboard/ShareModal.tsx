"use client";

import { useState } from "react";
import { useLanguage } from '@/lib/i18n';
import { shareModal } from '@/lib/i18n/translations/dashboard';
import { common } from '@/lib/i18n/translations/common';
import { api } from "@/lib/api";
import type { CreateShareResponse } from "@/lib/types";

interface ShareModalProps {
  roomId: string;
  roomName: string;
  token: string;
  onClose: () => void;
}

export default function ShareModal({ roomId, roomName, token, onClose }: ShareModalProps) {
  const locale = useLanguage();
  const t = shareModal[locale];
  const tc = common[locale];
  const [shareData, setShareData] = useState<CreateShareResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const handleCreate = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.createShareLink(token, roomId);
      setShareData(data);
    } catch (err: any) {
      setError(err.message || t.failedToCreateLink);
    } finally {
      setLoading(false);
    }
  };

  const handleCopy = async () => {
    if (!shareData) return;
    try {
      await navigator.clipboard.writeText(shareData.share_url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError(t.failedToCopy);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="mx-4 w-full max-w-md rounded-xl border border-glass-border bg-deep-black p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-1 text-lg font-semibold text-text-primary">{t.shareRoom}</h2>
        <p className="mb-4 text-sm text-text-secondary">
          {t.createPublicLink} <span className="text-neon-cyan">{roomName}</span>
        </p>

        {error && (
          <div className="mb-4 rounded border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-400">
            {error}
          </div>
        )}

        {!shareData ? (
          <div className="flex justify-end gap-2">
            <button
              onClick={onClose}
              className="rounded border border-glass-border px-4 py-2 text-sm text-text-secondary hover:text-text-primary"
            >
              {tc.cancel}
            </button>
            <button
              onClick={handleCreate}
              disabled={loading}
              className="rounded border border-neon-cyan/50 bg-neon-cyan/10 px-4 py-2 text-sm text-neon-cyan hover:bg-neon-cyan/20 disabled:opacity-50"
            >
              {loading ? t.creating : t.createShareLink}
            </button>
          </div>
        ) : (
          <div>
            <div className="mb-4 flex items-center gap-2 rounded border border-glass-border bg-glass-bg px-3 py-2">
              <input
                type="text"
                readOnly
                value={shareData.share_url}
                className="flex-1 bg-transparent font-mono text-sm text-text-primary outline-none"
              />
              <button
                onClick={handleCopy}
                className="shrink-0 rounded border border-neon-cyan/50 bg-neon-cyan/10 px-3 py-1 text-xs text-neon-cyan hover:bg-neon-cyan/20"
              >
                {copied ? tc.copied : tc.copy}
              </button>
            </div>
            <p className="mb-4 text-xs text-text-secondary">
              {t.anyoneCanView}
            </p>
            <div className="flex justify-end">
              <button
                onClick={onClose}
                className="rounded border border-glass-border px-4 py-2 text-sm text-text-secondary hover:text-text-primary"
              >
                {tc.done}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
