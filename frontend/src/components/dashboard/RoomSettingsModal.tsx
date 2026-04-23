"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { api } from "@/lib/api";
import { useLanguage } from "@/lib/i18n";
import { roomSettingsModal } from "@/lib/i18n/translations/dashboard";
import { useDashboardChatStore } from "@/store/useDashboardChatStore";

interface RoomSettingsModalProps {
  roomId: string;
  initialName: string;
  initialDescription: string;
  initialRule: string;
  onClose: () => void;
}

export default function RoomSettingsModal({
  roomId,
  initialName,
  initialDescription,
  initialRule,
  onClose,
}: RoomSettingsModalProps) {
  const locale = useLanguage();
  const t = roomSettingsModal[locale];
  const refreshOverview = useDashboardChatStore((s) => s.refreshOverview);

  const [name, setName] = useState(initialName);
  const [description, setDescription] = useState(initialDescription);
  const [rule, setRule] = useState(initialRule);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSave = async () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError(t.nameRequired);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const patch: { name?: string; description?: string; rule?: string | null } = {};
      if (trimmedName !== initialName) patch.name = trimmedName;
      if (description !== initialDescription) patch.description = description;
      if (rule !== initialRule) patch.rule = rule.trim() ? rule : null;
      if (Object.keys(patch).length > 0) {
        await api.updateRoomSettings(roomId, patch);
        await refreshOverview({ reloadOpenedRoom: true });
      }
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : t.saveFailed);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="mx-4 w-full max-w-md rounded-xl border border-glass-border bg-deep-black p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-4 text-lg font-semibold text-text-primary">{t.title}</h2>

        {error && (
          <div className="mb-4 rounded border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-400">
            {error}
          </div>
        )}

        <div className="space-y-4">
          <div>
            <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.16em] text-text-secondary/70">
              {t.nameLabel}
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={120}
              className="w-full rounded border border-glass-border bg-glass-bg px-3 py-2 text-sm text-text-primary outline-none focus:border-neon-cyan/50"
            />
          </div>
          <div>
            <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.16em] text-text-secondary/70">
              {t.descriptionLabel}
            </label>
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={500}
              className="w-full rounded border border-glass-border bg-glass-bg px-3 py-2 text-sm text-text-primary outline-none focus:border-neon-cyan/50"
            />
          </div>
          <div>
            <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.16em] text-text-secondary/70">
              {t.ruleLabel}
            </label>
            <textarea
              value={rule}
              onChange={(e) => setRule(e.target.value)}
              rows={6}
              maxLength={4000}
              className="w-full resize-none rounded border border-glass-border bg-glass-bg px-3 py-2 text-sm leading-relaxed text-text-primary outline-none focus:border-neon-cyan/50"
            />
            <p className="mt-1 text-[10px] text-text-secondary/60">{t.ruleHint}</p>
          </div>
        </div>

        <div className="mt-6 flex justify-end gap-2">
          <button
            onClick={onClose}
            disabled={saving}
            className="rounded border border-glass-border px-4 py-2 text-sm text-text-secondary hover:text-text-primary disabled:opacity-50"
          >
            {t.cancel}
          </button>
          <button
            onClick={() => void handleSave()}
            disabled={saving}
            className="inline-flex items-center gap-2 rounded border border-neon-cyan/50 bg-neon-cyan/10 px-4 py-2 text-sm text-neon-cyan hover:bg-neon-cyan/20 disabled:opacity-50"
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {saving ? t.saving : t.save}
          </button>
        </div>
      </div>
    </div>
  );
}
