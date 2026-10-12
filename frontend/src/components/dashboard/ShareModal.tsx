/**
 * [INPUT]: 依赖 share/invite API 生成房间分享资产，依赖 onboarding prompt builder 生成可转发给 Agent 的引导文本
 * [OUTPUT]: 对外提供 ShareModal 组件，统一承载房间分享预览、房间 Meta 信息与最小化复制动作
 * [POS]: dashboard 房间分享入口，将底层 share/invite 能力包装成更克制的生产级分享弹窗
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */
"use client";
import Badge from "@/components/ui/Badge";
import Avatar from "@/components/ui/Avatar";
import Skeleton from "@/components/ui/Skeleton";
import Card from "@/components/ui/Card";
import Alert from "@/components/ui/Alert";
import DialogSurface from "@/components/ui/DialogSurface";

import IconButton from "@/components/ui/IconButton";
import Button from "@/components/ui/Button";

import { withDashboardOverlayPortal } from "./DashboardOverlayPortal";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLanguage } from "@/lib/i18n";
import { shareModal } from "@/lib/i18n/translations/dashboard";
import { common } from "@/lib/i18n/translations/common";
import { api, humansApi } from "@/lib/api";
import { useDashboardSessionStore } from "@/store/useDashboardSessionStore";
import type { CreateShareResponse, InvitePreviewResponse, PublicRoomMember } from "@/lib/types";
import { Globe2, Link2, Loader2, Lock, Sparkles, X } from "lucide-react";
import { initialsFromName, themeFromRoomName } from "./roomVisualTheme";
import { animateOverlayPanelEnter, animateOverlayPanelExit, cleanupAnime } from "@/lib/anime";

interface ShareModalProps {
  roomId: string;
  roomName: string;
  roomVisibility?: string;
  canInvite?: boolean;
  onClose: () => void;
}

export default withDashboardOverlayPortal(ShareModal);

function ShareModal({ roomId, roomName, roomVisibility, canInvite = true, onClose }: ShareModalProps) {
  const locale = useLanguage();
  const t = shareModal[locale];
  const tc = common[locale];
  const isHumanView = useDashboardSessionStore((state) => state.viewMode === "human");
  const [shareData, setShareData] = useState<(CreateShareResponse | InvitePreviewResponse) | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedField, setCopiedField] = useState<"plain-link" | null>(null);
  const [members, setMembers] = useState<PublicRoomMember[]>([]);
  const [memberTotal, setMemberTotal] = useState(0);
  const [membersLoading, setMembersLoading] = useState(true);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const motionRef = useRef<ReturnType<typeof animateOverlayPanelEnter>>(null);
  const closingRef = useRef(false);

  const closeWithAnimation = useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    cleanupAnime(motionRef.current);
    motionRef.current = animateOverlayPanelExit(overlayRef.current, panelRef.current, {
      direction: "center",
      contentSelector: "[data-overlay-section]",
      onComplete: onClose,
    });
  }, [onClose]);

  useEffect(() => {
    motionRef.current = animateOverlayPanelEnter(overlayRef.current, panelRef.current, { onComplete: () => { if (panelRef.current) panelRef.current.style.transform = "none"; },
      direction: "center",
      contentSelector: "[data-overlay-section]",
    });
    return () => cleanupAnime(motionRef.current);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setMembersLoading(true);
    api.getRoomMembers(roomId)
      .catch(() => api.getPublicRoomMembers(roomId))
      .then((result) => {
        if (cancelled) return;
        setMembers(result.members.slice(0, 8));
        setMemberTotal(result.total || result.members.length);
        setMembersLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setMembers([]);
        setMemberTotal(0);
        setMembersLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [roomId]);

  const handleCreate = async () => {
    setLoading(true);
    setError(null);
    try {
      const inviteApi = isHumanView ? humansApi : api;
      const data = roomVisibility === "private"
        ? await inviteApi.createRoomInvite(roomId)
        : await inviteApi.createShareLink(roomId);
      setShareData(data);
    } catch (err: any) {
      setError(err.message || t.failedToCreateLink);
    } finally {
      setLoading(false);
    }
  };

  const plainLinkUrl = shareData ? ("link_url" in shareData ? shareData.link_url : shareData.invite_url) : "";
  const entryType = shareData?.entry_type;
  const roomVisualTheme = useMemo(() => themeFromRoomName(roomName || roomId), [roomId, roomName]);
  const roomInitials = useMemo(() => initialsFromName(roomName || "Room"), [roomName]);
  const accessLabel = entryType === "private_invite"
    ? t.accessInviteOnly
    : entryType === "private_room"
      ? t.accessPrivateSnapshot
      : entryType === "paid_room"
        ? t.accessPaidEntry
        : t.accessPublicSnapshot;
  const visibilityLabel = roomVisibility === "private" ? t.visibilityPrivate : t.visibilityPublic;
  const distributionLabel = entryType === "private_invite" ? t.channelInvite : t.channelLink;
  const statusNote = entryType === "private_invite"
    ? t.privateInviteNote
    : entryType === "private_room"
      ? t.privateRoomNote
      : t.anyoneCanView;
  const visibleMembers = members.slice(0, 6);
  const remainingMembers = Math.max(memberTotal - visibleMembers.length, 0);
  const memberAvatarTones = [
    "from-[var(--bc-agent-cyan)] to-[var(--bc-agent-cyan)]",
    "from-[var(--bc-agent-coral)] to-[var(--bc-agent-coral)]",
    "from-[var(--bc-agent-violet)] to-[var(--bc-agent-violet)]",
    "from-[var(--bc-agent-amber)] to-[var(--bc-agent-amber)]",
    "from-[var(--bc-agent-blue)] to-[var(--bc-agent-blue)]",
  ] as const;
  const memberSkeletonCount = 4;

  const flashCopiedField = (field: "plain-link") => {
    setCopiedField(field);
    setTimeout(() => setCopiedField(null), 2000);
  };

  const handleCopyText = async (value: string, field: "plain-link") => {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      flashCopiedField(field);
    } catch {
      setError(t.failedToCopy);
    }
  };

  const handleCopyPlainLink = async () => {
    if (!shareData) return;
    await handleCopyText(plainLinkUrl, "plain-link");
  };

  return (
    <DialogSurface overlayRef={overlayRef} panelRef={panelRef} onClose={closeWithAnimation} title={<>{roomName}</>} busy={closingRef.current} overlayClassName="z-50" className="max-w-2xl overflow-hidden">
        <div className="relative flex max-h-[90vh] flex-col overflow-hidden">
          <IconButton label={common[locale].close}
            onClick={closeWithAnimation}
            className="absolute right-3 z-10"
            aria-label={common[locale].close}
            title={common[locale].close}
          >
            <X className="h-4 w-4" />
          </IconButton>

          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
            {error ? (
              <Alert tone="danger" className="mb-5">
                {error}
              </Alert>
            ) : null}

            <section className="w-full" data-overlay-section>
              <div
                className="relative h-56 overflow-hidden rounded-3xl border border-glass-border"
                style={{ backgroundImage: roomVisualTheme.patternUrl, backgroundRepeat: "repeat" }}
              >
                <div className="absolute inset-0 bg-surface/90" />
                <div className="absolute inset-x-0 top-0 flex items-start justify-between gap-3 p-5">
                  <div>
                    <p className="text-xs font-semibold text-neon-cyan/80">{t.shareRoom}</p>
                  </div>
                  <div className="flex flex-wrap justify-end gap-2">
                    <Badge >{visibilityLabel}</Badge>
                    <Badge >{accessLabel}</Badge>
                  </div>
                </div>
                <div className="absolute inset-x-0 bottom-0 p-5">
                  <div className="space-y-4">
                    <div className="flex items-center gap-4">
                      <Avatar kind="room" id={roomId} name={roomName} size="xl" />
                      <div className="min-w-0">
                        <h2 id="share-modal-title" className="truncate text-4xl font-semibold leading-none text-text-primary">{roomName}</h2>
                        <p className="mt-3 text-sm leading-6 text-text-secondary">{t.createShareAssets}</p>
                      </div>
                    </div>
                    {membersLoading ? (
                      <div className="flex items-center gap-2 overflow-hidden" aria-hidden="true">
                        {Array.from({ length: memberSkeletonCount }, (_, index) => (
                          <Skeleton shape="circle" height={40} width={40} key={`member-skeleton-${index}`} />
                        ))}
                        <Skeleton shape="circle" height={40} width={64} />
                      </div>
                    ) : visibleMembers.length > 0 ? (
                      <div className="flex items-center gap-2 overflow-hidden">
                        {visibleMembers.map((member, index) => (
                          <Avatar key={member.agent_id} kind="agent" id={member.agent_id} name={member.display_name || member.agent_id} size="md" />
                        ))}
                        {remainingMembers > 0 ? (
                          <Card padding="none" className="flex h-10 shrink-0 items-center justify-center px-3">
                            +{remainingMembers}
                          </Card>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                </div>
              </div>

              <div className="space-y-4 px-1 pt-5" data-overlay-section>
                {!canInvite ? (
                  <div className="space-y-3">
                    <Button variant="row"
                      onClick={() => void handleCopyText(typeof window !== "undefined" ? window.location.href : "", "plain-link")}
                      className="w-full"
                    >
                      <div className="flex items-start gap-3">
                        <div className="mt-0.5 rounded-xl bg-neon-cyan/12 p-2 text-neon-cyan">
                          <Link2 className="h-4 w-4" />
                        </div>
                        <div>
                          <p className="text-sm font-medium text-text-primary">{t.copyCurrentUrlTitle}</p>
                          <p className="mt-1 text-xs leading-5 text-text-secondary">{t.copyCurrentUrlDescription}</p>
                        </div>
                      </div>
                      <Badge >
                        {copiedField === "plain-link" ? tc.copied : tc.copy}
                      </Badge>
                    </Button>
                  </div>
                ) : !shareData ? (
                    <div className="space-y-3">
                      <p className="text-sm leading-6 text-text-secondary">{t.shareSetupDescription}</p>
                      <Button variant="primary"
                        onClick={handleCreate}
                        disabled={loading}
                        className="w-full"
                      >
                        {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                        {loading ? t.creating : t.createShareLink}
                      </Button>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      <Button variant="row"
                        onClick={() => void handleCopyPlainLink()}
                        className="w-full"
                      >
                        <div className="flex items-start gap-3">
                          <div className="mt-0.5 rounded-xl bg-neon-cyan/12 p-2 text-neon-cyan">
                            <Link2 className="h-4 w-4" />
                          </div>
                          <div>
                            <p className="text-sm font-medium text-text-primary">{t.copyPlainLinkChannelTitle}</p>
                            <p className="mt-1 text-xs leading-5 text-text-secondary">{t.copyPlainLinkChannelDescription}</p>
                            {plainLinkUrl ? (
                              <p className="mt-2 max-w-[18rem] truncate text-xs leading-5 text-text-secondary">{plainLinkUrl}</p>
                            ) : null}
                          </div>
                        </div>
                        <Badge >
                          {copiedField === "plain-link" ? tc.copied : tc.copy}
                        </Badge>
                      </Button>
                    </div>
                  )
                }

                <Card padding="none" className="px-4 py-4">
                  <div className="flex items-center gap-2 text-xs font-semibold text-text-secondary">
                    {entryType === "private_invite" || roomVisibility === "private" ? <Lock className="h-3.5 w-3.5" /> : <Globe2 className="h-3.5 w-3.5" />}
                    {distributionLabel}
                  </div>
                  <p className="mt-2 text-sm leading-6 text-text-secondary">{statusNote}</p>
                </Card>
              </div>
            </section>
          </div>
        </div>
      </DialogSurface>
  );
}
