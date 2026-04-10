"use client";

import { useState } from "react";
import { useLanguage } from '@/lib/i18n';
import { shareModal } from '@/lib/i18n/translations/dashboard';
import { common } from '@/lib/i18n/translations/common';
import { api } from "@/lib/api";
import type { CreateShareResponse, InvitePreviewResponse } from "@/lib/types";
import { buildSharePrompt } from "@/lib/onboarding";
import { Loader2 } from "lucide-react";

interface ShareModalProps {
  roomId: string;
  roomName: string;
  roomVisibility?: string;
  onClose: () => void;
}

export default function ShareModal({ roomId, roomName, roomVisibility, onClose }: ShareModalProps) {
  const locale = useLanguage();
  const t = shareModal[locale];
  const tc = common[locale];
  const [shareData, setShareData] = useState<(CreateShareResponse | InvitePreviewResponse) | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedField, setCopiedField] = useState<"link" | "prompt" | null>(null);

  const handleCreate = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = roomVisibility === "private"
        ? await api.createRoomInvite(roomId)
        : await api.createShareLink(roomId);
      setShareData(data);
    } catch (err: any) {
      setError(err.message || t.failedToCreateLink);
    } finally {
      setLoading(false);
    }
  };

  const handleCopyLink = async () => {
    if (!shareData) return;
    try {
      await navigator.clipboard.writeText("link_url" in shareData ? shareData.link_url : shareData.invite_url);
      setCopiedField("link");
      setTimeout(() => setCopiedField(null), 2000);
    } catch {
      setError(t.failedToCopy);
    }
  };

  const resolveProductId = (sd: typeof shareData): string | undefined => {
    if (!sd) return undefined;
    if ("required_subscription_product_id" in sd && sd.required_subscription_product_id) {
      return sd.required_subscription_product_id as string;
    }
    if ("room" in sd && sd.room && "required_subscription_product_id" in sd.room) {
      return sd.room.required_subscription_product_id ?? undefined;
    }
    return undefined;
  };

  const handleCopyPrompt = async () => {
    if (!shareData) return;
    try {
      const shareId = "share_id" in shareData ? shareData.share_id : undefined;
      const inviteCode = "code" in shareData ? shareData.code : undefined;
      const entryType = shareData.entry_type;
      await navigator.clipboard.writeText(
        buildSharePrompt({
          shareId,
          inviteCode,
          roomId,
          roomName,
          requiresPayment: shareData.entry_type === "paid_room",
          productId: resolveProductId(shareData),
          isReadOnly: entryType === "private_room",
          locale,
        }),
      );
      setCopiedField("prompt");
      setTimeout(() => setCopiedField(null), 2000);
    } catch {
      setError(t.failedToCopy);
    }
  };

  const shareUrl = shareData ? ("link_url" in shareData ? shareData.link_url : shareData.invite_url) : "";
  const entryType = shareData?.entry_type;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="mx-4 w-full max-w-md rounded-xl border border-glass-border bg-deep-black p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-1 text-lg font-semibold text-text-primary">{t.shareRoom}</h2>
        <p className="mb-4 text-sm text-text-secondary">
          {t.createShareAssets} <span className="text-neon-cyan">{roomName}</span>
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
              className="inline-flex items-center gap-2 rounded border border-neon-cyan/50 bg-neon-cyan/10 px-4 py-2 text-sm text-neon-cyan hover:bg-neon-cyan/20 disabled:opacity-50"
            >
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {loading ? t.creating : t.createShareLink}
            </button>
          </div>
        ) : (
          <div>
            <div className="space-y-4">
              <div>
                <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-text-secondary/70">
                  {t.shareLink}
                </p>
                <div className="flex items-center gap-2 rounded border border-glass-border bg-glass-bg px-3 py-2">
                  <input
                    type="text"
                    readOnly
                    value={shareUrl}
                    className="flex-1 bg-transparent font-mono text-sm text-text-primary outline-none"
                  />
                  <button
                    onClick={handleCopyLink}
                    className="shrink-0 rounded border border-neon-cyan/50 bg-neon-cyan/10 px-3 py-1 text-xs text-neon-cyan hover:bg-neon-cyan/20"
                  >
                    {copiedField === "link" ? tc.copied : tc.copy}
                  </button>
                </div>
              </div>
              <div>
                <div className="mb-2 flex items-center justify-between gap-3">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-text-secondary/70">
                    {t.sharePrompt}
                  </p>
                  <button
                    onClick={handleCopyPrompt}
                    className="shrink-0 rounded border border-neon-cyan/50 bg-neon-cyan/10 px-3 py-1 text-xs text-neon-cyan hover:bg-neon-cyan/20"
                  >
                    {copiedField === "prompt" ? tc.copied : t.copyPrompt}
                  </button>
                </div>
                <textarea
                  readOnly
                  value={buildSharePrompt({
                    shareId: shareData && "share_id" in shareData ? shareData.share_id : undefined,
                    inviteCode: shareData && "code" in shareData ? shareData.code : undefined,
                    roomId,
                    roomName,
                    requiresPayment: entryType === "paid_room",
                    productId: resolveProductId(shareData),
                    isReadOnly: entryType === "private_room",
                    locale,
                  })}
                  rows={6}
                  className="w-full resize-none rounded border border-glass-border bg-glass-bg px-3 py-2 font-mono text-xs leading-relaxed text-text-primary outline-none"
                />
              </div>
            </div>
            <p className="mt-3 mb-4 text-xs text-text-secondary">
              {entryType === "private_invite" ? t.privateInviteNote : t.anyoneCanView}
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
