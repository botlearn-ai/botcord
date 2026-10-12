"use client";
import Field from "@/components/ui/Field";
import Alert from "@/components/ui/Alert";
import DialogSurface from "@/components/ui/DialogSurface";

import IconButton from "@/components/ui/IconButton";
import { Input } from "@/components/ui/Input";
import { Textarea } from "@/components/ui/Input";
import Button from "@/components/ui/Button";

import { withDashboardOverlayPortal } from "./DashboardOverlayPortal";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Loader2, Settings, Trash2, X } from "lucide-react";
import { userApi } from "@/lib/api";
import { useLanguage } from "@/lib/i18n";
import { useDashboardSessionStore } from "@/store/useDashboardSessionStore";
import UnbindAgentDialog from "./UnbindAgentDialog";
import AgentAvatarPicker from "./AgentAvatarPicker";
import { animateOverlayPanelEnter, animateOverlayPanelExit, animatePop, cleanupAnime } from "@/lib/anime";

interface AgentProfileEditModalProps {
  agentId: string;
  initialDisplayName: string;
  initialBio?: string | null;
  initialAvatarUrl?: string | null;
  onClose: () => void;
  onSaved?: () => void;
}

export default withDashboardOverlayPortal(AgentProfileEditModal);

function AgentProfileEditModal({
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
  const [closing, setClosing] = useState(false);
  const overlayRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const animationRef = useRef<ReturnType<typeof animateOverlayPanelEnter>>(null);
  const errorAnimationRef = useRef<ReturnType<typeof animatePop>>(null);

  useEffect(() => {
    setDisplayName(initialDisplayName);
    setBio(initialBio ?? "");
    setAvatarUrl(initialAvatarUrl ?? "");
  }, [initialDisplayName, initialBio, initialAvatarUrl]);

  const trimmedName = displayName.trim();
  const nameChanged = trimmedName !== initialDisplayName.trim();
  const bioChanged = (bio ?? "").trim() !== (initialBio ?? "").trim();
  const avatarChanged = avatarUrl !== (initialAvatarUrl ?? "");
  const canSave = !saving && trimmedName.length > 0 && (nameChanged || bioChanged || avatarChanged);

  const closeWithMotion = useCallback((force = false) => {
    if ((saving && !force) || closing) return;
    setClosing(true);
    cleanupAnime(animationRef.current);
    animationRef.current = animateOverlayPanelExit(overlayRef.current, panelRef.current, {
      onComplete: onClose,
    });
  }, [closing, onClose, saving]);

  useLayoutEffect(() => {
    animationRef.current = animateOverlayPanelEnter(overlayRef.current, panelRef.current, {
      contentSelector: "[data-agent-profile-modal-part]",
      onComplete: () => { if (panelRef.current) panelRef.current.style.transform = "none";
        animationRef.current = null;
      },
    });
    return () => cleanupAnime(animationRef.current);
  }, []);

  useEffect(() => {
    if (!error || !errorRef.current) return;
    cleanupAnime(errorAnimationRef.current);
    errorAnimationRef.current = animatePop(errorRef.current);
  }, [error]);

  useEffect(() => () => {
    cleanupAnime(animationRef.current);
    cleanupAnime(errorAnimationRef.current);
  }, []);

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
      closeWithMotion(true);
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
    <DialogSurface overlayRef={overlayRef} panelRef={panelRef} onClose={closeWithMotion} title={<><Settings className="h-5 w-5 text-neon-cyan" />{tTitle}</>} overlayClassName="z-[110]" className="max-w-md p-5">
        <IconButton label="Close"
          onClick={() => closeWithMotion()}
          disabled={saving}
          className="absolute right-4"
        >
          <X className="h-5 w-5" />
        </IconButton>

        <div data-agent-profile-modal-part className="mb-5 pr-8">
          <h3 className="flex items-center gap-2 text-xl font-semibold text-text-primary">
            <Settings className="h-5 w-5 text-neon-cyan" />
            {tTitle}
          </h3>
          <p className="mt-2 text-sm text-text-secondary">{tDesc}</p>
          <p className="mt-1 font-mono text-xs text-text-secondary">{agentId}</p>
        </div>

        <div data-agent-profile-modal-part className="mb-3">
          <span className="mb-2 block text-xs font-medium text-text-secondary">
            {locale === "zh" ? "头像" : "Avatar"}
          </span>
          <AgentAvatarPicker
            value={avatarUrl}
            onChange={setAvatarUrl}
            disabled={saving}
            colorLabel={locale === "zh" ? "头像颜色" : "Avatar colour"}
            avatarLabel={locale === "zh" ? "选择头像" : "Select avatar"}
          />
        </div>

        <Field label={<>{tNameLabel}</>} data-agent-profile-modal-part className="mb-3 block">

          <Input
            type="text"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            disabled={saving}
            maxLength={128}
            className="w-full"
          />
        </Field>

        <Field label={<>{tBioLabel}</>} data-agent-profile-modal-part className="block">

          <Textarea
            value={bio}
            onChange={(e) => setBio(e.target.value)}
            disabled={saving}
            rows={4}
            maxLength={4000}
            placeholder={tBioPlaceholder}
            className="w-full"
          />
        </Field>

        {error && (
          <Alert tone="danger" ref={errorRef} className="mt-3">
            {error}
          </Alert>
        )}

        <div data-agent-profile-modal-part className="mt-6 flex items-center justify-end gap-3">
          <Button variant="secondary"
            onClick={() => closeWithMotion()}
            disabled={saving}

          >
            {tCancel}
          </Button>
          <Button variant="primary"
            onClick={handleSave}
            disabled={!canSave}

          >
            {saving ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                {tSaving}
              </>
            ) : (
              tSave
            )}
          </Button>
        </div>

        <div data-agent-profile-modal-part className="mt-6 border-t border-glass-border pt-4">
          <Button variant="danger"
            onClick={() => setShowUnbind(true)}
            disabled={saving}
            className="w-full"
          >
            <Trash2 className="h-4 w-4" />
            {tDelete}
          </Button>
        </div>
      </DialogSurface>
  );
}
