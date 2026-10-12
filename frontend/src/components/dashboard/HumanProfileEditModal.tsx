"use client";
import Field from "@/components/ui/Field";
import Alert from "@/components/ui/Alert";
import Card from "@/components/ui/Card";
import DialogSurface from "@/components/ui/DialogSurface";

import IconButton from "@/components/ui/IconButton";
import { Input } from "@/components/ui/Input";
import Button from "@/components/ui/Button";

import { withDashboardOverlayPortal } from "./DashboardOverlayPortal";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Loader2, UserRound, X } from "lucide-react";
import { humansApi } from "@/lib/api";
import { useLanguage } from "@/lib/i18n";
import { useDashboardSessionStore } from "@/store/useDashboardSessionStore";
import { animateOverlayPanelEnter, animateOverlayPanelExit, animatePop, cleanupAnime } from "@/lib/anime";

interface HumanProfileEditModalProps {
  onClose: () => void;
}

export default withDashboardOverlayPortal(HumanProfileEditModal);

function HumanProfileEditModal({ onClose }: HumanProfileEditModalProps) {
  const locale = useLanguage();
  const human = useDashboardSessionStore((s) => s.human);
  const setHuman = useDashboardSessionStore((s) => s.setHuman);

  const [displayName, setDisplayName] = useState(human?.display_name ?? "");
  const [avatarUrl, setAvatarUrl] = useState(human?.avatar_url ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [closing, setClosing] = useState(false);
  const overlayRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const animationRef = useRef<ReturnType<typeof animateOverlayPanelEnter>>(null);
  const errorAnimationRef = useRef<ReturnType<typeof animatePop>>(null);

  useEffect(() => {
    setDisplayName(human?.display_name ?? "");
    setAvatarUrl(human?.avatar_url ?? "");
  }, [human]);

  const trimmedName = displayName.trim();
  const trimmedAvatar = avatarUrl.trim();
  const nameChanged = trimmedName !== (human?.display_name ?? "").trim();
  const avatarChanged = trimmedAvatar !== (human?.avatar_url ?? "").trim();
  const canSave = !saving && trimmedName.length > 0 && (nameChanged || avatarChanged);

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
      contentSelector: "[data-human-profile-modal-part]",
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
      const patch: { display_name?: string; avatar_url?: string | null } = {};
      if (nameChanged) patch.display_name = trimmedName;
      if (avatarChanged) patch.avatar_url = trimmedAvatar || null;
      const updated = await humansApi.updateProfile(patch);
      setHuman(updated);
      closeWithMotion(true);
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
    <DialogSurface overlayRef={overlayRef} panelRef={panelRef} onClose={closeWithMotion} title={<><UserRound className="h-5 w-5 text-neon-cyan" />{tTitle}</>} overlayClassName="z-[110]" className="max-w-md p-5">
        <IconButton label="Close"
          onClick={() => closeWithMotion()}
          disabled={saving}
          className="absolute right-4"
        >
          <X className="h-5 w-5" />
        </IconButton>

        <div data-human-profile-modal-part className="mb-5 pr-8">
          <h3 className="flex items-center gap-2 text-xl font-semibold text-text-primary">
            <UserRound className="h-5 w-5 text-neon-cyan" />
            {tTitle}
          </h3>
          <p className="mt-2 text-sm text-text-secondary">{tDesc}</p>
          {human && (
            <p className="mt-1 font-mono text-xs text-text-secondary">{human.human_id}</p>
          )}
        </div>

        <Field label={<>{tNameLabel}</>} data-human-profile-modal-part className="mb-3 block">

          <Input
            type="text"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            disabled={saving}
            maxLength={128}
            className="w-full"
          />
        </Field>

        <Field label={<>{tAvatarLabel}</>} data-human-profile-modal-part className="block">

          <Input
            type="url"
            value={avatarUrl}
            onChange={(e) => setAvatarUrl(e.target.value)}
            disabled={saving}
            maxLength={2048}
            placeholder={tAvatarPlaceholder}
            className="w-full"
          />
        </Field>

        {trimmedAvatar && (
          <Card padding="none" data-human-profile-modal-part className="mt-3 flex items-center gap-2 p-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={trimmedAvatar}
              alt="Avatar preview"
              className="h-10 w-10 rounded-full border border-glass-border object-cover"
              onError={(e) => {
                (e.currentTarget as HTMLImageElement).style.display = "none";
              }}
            />
            <span className="truncate text-xs text-text-secondary">{trimmedAvatar}</span>
          </Card>
        )}

        {error && (
          <Alert tone="danger" ref={errorRef} className="mt-3">
            {error}
          </Alert>
        )}

        <div data-human-profile-modal-part className="mt-6 flex items-center justify-end gap-3">
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
      </DialogSurface>
  );
}
