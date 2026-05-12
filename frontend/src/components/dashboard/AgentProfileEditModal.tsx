"use client";

import { useEffect, useState } from "react";
import { Loader2, Settings, Trash2, X } from "lucide-react";
import { userApi } from "@/lib/api";
import { useLanguage } from "@/lib/i18n";
import { useDashboardSessionStore } from "@/store/useDashboardSessionStore";
import UnbindAgentDialog from "./UnbindAgentDialog";
import { AGENT_AVATAR_URLS } from "@/lib/agent-avatars";

interface AgentProfileEditModalProps {
  agentId: string;
  initialDisplayName: string;
  initialBio?: string | null;
  initialAvatarUrl?: string | null;
  onClose: () => void;
  onSaved?: () => void;
}

export default function AgentProfileEditModal({
  agentId,
  initialDisplayName,
  initialBio,
  initialAvatarUrl,
  onClose,
  onSaved,
}: AgentProfileEditModalProps) {
  const locale = useLanguage();
  const refreshUserProfile = useDashboardSessionStore((s) => s.refreshUserProfile);

  const [displayName, setDisplayName] = useState(initialDisplayName);
  const [bio, setBio] = useState(initialBio ?? "");
  const [avatarUrl, setAvatarUrl] = useState(initialAvatarUrl ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showUnbind, setShowUnbind] = useState(false);
  const [showAvatarPicker, setShowAvatarPicker] = useState(false);

  useEffect(() => {
    setDisplayName(initialDisplayName);
    setBio(initialBio ?? "");
    setAvatarUrl(initialAvatarUrl ?? "");
    setShowAvatarPicker(false);
  }, [initialDisplayName, initialBio, initialAvatarUrl]);

  const trimmedName = displayName.trim();
  const nameChanged = trimmedName !== initialDisplayName.trim();
  const bioChanged = (bio ?? "").trim() !== (initialBio ?? "").trim();
  const avatarChanged = avatarUrl !== (initialAvatarUrl ?? "");
  const canSave = !saving && trimmedName.length > 0 && (nameChanged || bioChanged || avatarChanged);

  async function handleSave() {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      const patch: { display_name?: string; bio?: string | null; avatar_url?: string | null } = {};
      if (nameChanged) patch.display_name = trimmedName;
      if (bioChanged) patch.bio = bio.trim() || null;
      if (avatarChanged) patch.avatar_url = avatarUrl || null;
      await userApi.updateAgent(agentId, patch);
      await refreshUserProfile();
      onSaved?.();
      onClose();
    } catch (err: any) {
      setError(err?.message || (locale === "zh" ? "保存失败" : "Failed to save"));
      setSaving(false);
    }
  }

  const tTitle = locale === "zh" ? "编辑 Bot 资料" : "Edit Bot Profile";
  const tDesc = locale === "zh" ? "更新该 Bot 的显示名称与简介。" : "Update this bot's display name and bio.";
  const tNameLabel = locale === "zh" ? "显示名称" : "Display name";
  const tBioLabel = locale === "zh" ? "简介" : "Bio";
  const tBioPlaceholder = locale === "zh" ? "介绍这个 Bot（可选）" : "Introduce this bot (optional)";
  const tCancel = locale === "zh" ? "取消" : "Cancel";
  const tSave = locale === "zh" ? "保存" : "Save";
  const tSaving = locale === "zh" ? "保存中..." : "Saving...";
  const tDelete = locale === "zh" ? "删除 Bot" : "Delete Bot";

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
            <Settings className="h-5 w-5 text-neon-cyan" />
            {tTitle}
          </h3>
          <p className="mt-2 text-sm text-text-secondary">{tDesc}</p>
          <p className="mt-1 font-mono text-[10px] text-text-secondary/60">{agentId}</p>
        </div>

        <div className="mb-3">
          <span className="mb-2 block text-xs font-medium text-text-secondary">
            {locale === "zh" ? "头像" : "Avatar"}
          </span>
          <button
            type="button"
            onClick={() => setShowAvatarPicker((open) => !open)}
            disabled={saving}
            className="h-14 w-14 overflow-hidden rounded-full border border-neon-cyan bg-glass-bg ring-2 ring-neon-cyan/30 transition-all hover:border-neon-cyan/80 disabled:opacity-60"
            aria-label={locale === "zh" ? "更换头像" : "Change avatar"}
            aria-expanded={showAvatarPicker}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={avatarUrl || AGENT_AVATAR_URLS[0]}
              alt=""
              className="h-full w-full object-cover"
            />
          </button>
          {showAvatarPicker && (
            <div className="mt-3 grid max-h-40 grid-cols-6 gap-2 overflow-y-auto pr-1">
              {AGENT_AVATAR_URLS.map((url) => {
                const selected = avatarUrl === url;
                return (
                  <button
                    key={url}
                    type="button"
                    onClick={() => {
                      setAvatarUrl(url);
                      setShowAvatarPicker(false);
                    }}
                    disabled={saving}
                    className={`aspect-square overflow-hidden rounded-full border bg-glass-bg transition-all disabled:opacity-60 ${
                      selected
                        ? "border-neon-cyan ring-2 ring-neon-cyan/30"
                        : "border-glass-border hover:border-neon-cyan/50"
                    }`}
                    aria-label={locale === "zh" ? "选择头像" : "Select avatar"}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={url} alt="" className="h-full w-full object-cover" />
                  </button>
                );
              })}
            </div>
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
            className="w-full rounded-lg border border-glass-border bg-glass-bg px-3 py-2 text-sm text-text-primary outline-none transition-colors focus:border-neon-cyan/50 disabled:opacity-60"
          />
        </label>

        <label className="block">
          <span className="mb-1 block text-xs font-medium text-text-secondary">{tBioLabel}</span>
          <textarea
            value={bio}
            onChange={(e) => setBio(e.target.value)}
            disabled={saving}
            rows={4}
            maxLength={4000}
            placeholder={tBioPlaceholder}
            className="w-full resize-none rounded-lg border border-glass-border bg-glass-bg px-3 py-2 text-sm text-text-primary outline-none transition-colors focus:border-neon-cyan/50 disabled:opacity-60"
          />
        </label>

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
            className="flex items-center gap-2 rounded-xl border border-neon-cyan/40 bg-neon-cyan/10 px-4 py-2.5 text-sm font-bold text-neon-cyan transition-all hover:bg-neon-cyan/20 disabled:opacity-60"
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

        <div className="mt-6 border-t border-glass-border pt-4">
          <button
            onClick={() => setShowUnbind(true)}
            disabled={saving}
            className="flex w-full items-center justify-center gap-2 rounded-xl border border-red-400/40 bg-red-500/10 px-4 py-2.5 text-sm font-bold text-red-400 transition-all hover:bg-red-500/20 disabled:opacity-60"
          >
            <Trash2 className="h-4 w-4" />
            {tDelete}
          </button>
        </div>
      </div>

      {showUnbind && (
        <UnbindAgentDialog
          agentId={agentId}
          agentName={initialDisplayName}
          onClose={() => setShowUnbind(false)}
          onUnbound={async () => {
            await refreshUserProfile();
            onSaved?.();
            onClose();
          }}
        />
      )}
    </div>
  );
}
