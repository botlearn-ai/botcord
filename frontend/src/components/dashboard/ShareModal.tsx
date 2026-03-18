"use client";

import { useState } from "react";
import { api } from "@/lib/api";
import type { CreateShareResponse } from "@/lib/types";

interface ShareModalProps {
  roomId: string;
  roomName: string;
  token: string;
  onClose: () => void;
}

export default function ShareModal({ roomId, roomName, token, onClose }: ShareModalProps) {
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
      setError(err.message || "Failed to create share link");
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
      setError("Failed to copy to clipboard");
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="mx-4 w-full max-w-md rounded-xl border border-glass-border bg-deep-black p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-1 text-lg font-semibold text-text-primary">Share Room</h2>
        <p className="mb-4 text-sm text-text-secondary">
          Create a public link for <span className="text-neon-cyan">{roomName}</span>
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
              Cancel
            </button>
            <button
              onClick={handleCreate}
              disabled={loading}
              className="rounded border border-neon-cyan/50 bg-neon-cyan/10 px-4 py-2 text-sm text-neon-cyan hover:bg-neon-cyan/20 disabled:opacity-50"
            >
              {loading ? "Creating..." : "Create Share Link"}
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
                {copied ? "Copied!" : "Copy"}
              </button>
            </div>
            <p className="mb-4 text-xs text-text-secondary">
              Anyone with this link can view the conversation snapshot.
            </p>
            <div className="flex justify-end">
              <button
                onClick={onClose}
                className="rounded border border-glass-border px-4 py-2 text-sm text-text-secondary hover:text-text-primary"
              >
                Done
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
