"use client";

import { useEffect, useState } from "react";
import { Loader2, UserRound, X } from "lucide-react";
import { humansApi } from "@/lib/api";
import { useLanguage } from "@/lib/i18n";
import { useDashboardSessionStore } from "@/store/useDashboardSessionStore";

interface HumanProfileEditModalProps {
  onClose: () => void;
}

export default function HumanProfileEditModal({ onClose }: HumanProfileEditModalProps) {
  const locale = useLanguage();
  const human = useDashboardSessionStore((s) => s.human);
  const setHuman = useDashboardSessionStore((s) => s.setHuman);

  const [displayName, setDisplayName] = useState(human?.display_name ?? "");
  const [avatarUrl, setAvatarUrl] = useState(human?.avatar_url ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDisplayName(human?.display_name ?? "");
    setAvatarUrl(human?.avatar_url ?? "");
  }, [human]);

  const trimmedName = displayName.trim();
  const trimmedAvatar = avatarUrl.trim();
  const nameChanged = trimmedName !== (human?.display_name ?? "").trim();
  const avatarChanged = trimmedAvatar !== (human?.avatar_url ?? "").trim();
  const canSave = !saving && trimmedName.length > 0 && (nameChanged || avatarChanged);

  async function handleSave() {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      const patch: { display_name?: string; avatar_url?: string | null } = {};
      if (nameChanged) patch.display_name = trimmedName;
      if (avatarChanged) patch.avatar_url = trimmedAvatar || null;
      const updated = await humansApi.updateProfile(patch);
      setHuman(updated);
      onClose();
    } catch (err: any) {
      setError(err?.message || (locale === "zh" ? "保存失败" : "Failed to save"));
      setSaving(false);
    }
  }

  const tTitle = locale === "zh" ? "编辑个人资料" : "Edit Profile";
  const tDesc = locale === "zh" ? "更新你的显示名称和头像。" : "Update your display name and avatar.";
  const tNameLabel = locale === "zh" ? "显示名称" : "Display name";
  const tAvatarLabel = locale === "zh" ? "头像链接" : "Avatar URL";
  const tAvatarPlaceholder = locale === "zh" ? "https://... （可选）" : "https://... (optional)";
  const tCancel = locale === "zh" ? "取消" : "Cancel";
  const tSave = locale === "zh" ? "保存" : "Save";
  const tSaving = locale === "zh" ? "保存中..." : "Saving...";

  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
      <div className="relative w-full max-w-md rounded-2xl border border-glass-border bg-deep-black-light p-5 shadow-2xl">
        <button
          onClick={onClose}
          disabled={saving}
          className="absolute right-4 top-4 rounded-full p-1.5 text-text-secondary transition-colors hover:bg-glass-bg hover:text-text-primary disabled:opacity-50"
        >
          <X className="h-5 w-5" />
        </button>

        <div className="mb-5 pr-8">
          <h3 className="flex items-center gap-2 text-xl font-bold text-text-primary">
            <UserRound className="h-5 w-5 text-neon-purple" />
            {tTitle}
          </h3>
          <p className="mt-2 text-sm text-text-secondary">{tDesc}</p>
          {human && (
            <p className="mt-1 font-mono text-[10px] text-text-secondary/60">{human.human_id}</p>
          )}
        </div>

        <label className="mb-3 block">
          <span className="mb-1 block text-xs font-medium text-text-secondary">{tNameLabel}</span>
          <input
            type="text"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            disabled={saving}
            maxLength={128}
            className="w-full rounded-lg border border-glass-border bg-glass-bg px-3 py-2 text-sm text-text-primary outline-none transition-colors focus:border-neon-purple/50 disabled:opacity-60"
          />
        </label>

        <label className="block">
          <span className="mb-1 block text-xs font-medium text-text-secondary">{tAvatarLabel}</span>
          <input
            type="url"
            value={avatarUrl}
            onChange={(e) => setAvatarUrl(e.target.value)}
            disabled={saving}
            maxLength={2048}
            placeholder={tAvatarPlaceholder}
            className="w-full rounded-lg border border-glass-border bg-glass-bg px-3 py-2 text-sm text-text-primary outline-none transition-colors focus:border-neon-purple/50 disabled:opacity-60"
          />
        </label>

        {trimmedAvatar && (
          <div className="mt-3 flex items-center gap-2 rounded-lg border border-glass-border bg-glass-bg p-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={trimmedAvatar}
              alt="Avatar preview"
              className="h-10 w-10 rounded-full border border-white/10 object-cover"
              onError={(e) => {
                (e.currentTarget as HTMLImageElement).style.display = "none";
              }}
            />
            <span className="truncate text-[11px] text-text-secondary">{trimmedAvatar}</span>
          </div>
        )}

        {error && (
          <p className="mt-3 rounded-lg border border-red-400/20 bg-red-400/10 p-2 text-xs text-red-400">
            {error}
          </p>
        )}

        <div className="mt-6 flex items-center justify-end gap-3">
          <button
            onClick={onClose}
            disabled={saving}
            className="rounded-xl border border-glass-border px-4 py-2.5 text-sm font-medium text-text-secondary transition-colors hover:bg-glass-bg hover:text-text-primary disabled:opacity-50"
          >
            {tCancel}
          </button>
          <button
            onClick={handleSave}
            disabled={!canSave}
            className="flex items-center gap-2 rounded-xl border border-neon-purple/40 bg-neon-purple/10 px-4 py-2.5 text-sm font-bold text-neon-purple transition-all hover:bg-neon-purple/20 disabled:opacity-60"
          >
            {saving ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                {tSaving}
              </>
            ) : (
              tSave
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
