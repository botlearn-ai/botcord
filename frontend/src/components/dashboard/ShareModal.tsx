/**
 * [INPUT]: 依赖 share/invite API 生成群分享资产，依赖 onboarding prompt builder 生成可转发给 Agent 的引导文本
 * [OUTPUT]: 对外提供 ShareModal 组件，统一承载群分享预览、群 Meta 信息与最小化复制动作
 * [POS]: dashboard 群分享入口，将底层 share/invite 能力包装成更克制的生产级分享弹窗
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */
"use client";

import { useEffect, useMemo, useState } from "react";
import { useLanguage } from "@/lib/i18n";
import { shareModal } from "@/lib/i18n/translations/dashboard";
import { common } from "@/lib/i18n/translations/common";
import { api, humansApi } from "@/lib/api";
import { useDashboardSessionStore } from "@/store/useDashboardSessionStore";
import type { CreateShareResponse, InvitePreviewResponse, PublicRoomMember } from "@/lib/types";
import { Globe2, Link2, Loader2, Lock, Sparkles, X } from "lucide-react";
import { initialsFromName, themeFromRoomName } from "./roomVisualTheme";

interface ShareModalProps {
  roomId: string;
  roomName: string;
  roomVisibility?: string;
  canInvite?: boolean;
  onClose: () => void;
}

export default function ShareModal({ roomId, roomName, roomVisibility, canInvite = true, onClose }: ShareModalProps) {
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
    "from-[#5eead4]/80 to-[#0891b2]/80",
    "from-[#fda4af]/80 to-[#be185d]/80",
    "from-[#c4b5fd]/80 to-[#7c3aed]/80",
    "from-[#fde68a]/80 to-[#d97706]/80",
    "from-[#93c5fd]/80 to-[#2563eb]/80",
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4 py-6 backdrop-blur-sm" onClick={onClose}>
      <div
        className="relative w-full max-w-2xl overflow-hidden rounded-[28px] shadow-[0_32px_120px_rgba(0,0,0,0.45)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="relative flex max-h-[90vh] flex-col overflow-hidden">
          <button
            onClick={onClose}
            className="absolute right-3 top-3 z-10 rounded-full bg-black/25 p-2 text-text-secondary transition-colors hover:bg-white/10 hover:text-text-primary"
            aria-label={common[locale].close}
            title={common[locale].close}
          >
            <X className="h-4 w-4" />
          </button>

          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
            {error ? (
              <div className="mb-5 rounded-2xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
                {error}
              </div>
            ) : null}

            <section className="w-full">
              <div
                className="relative h-56 overflow-hidden rounded-[28px] border border-white/10"
                style={{ backgroundImage: roomVisualTheme.patternUrl, backgroundRepeat: "repeat" }}
              >
                <div className="absolute inset-0 bg-[linear-gradient(135deg,rgba(7,10,22,0.18),rgba(7,10,22,0.82))]" />
                <div className="absolute inset-x-0 top-0 flex items-start justify-between gap-3 p-5">
                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-[0.28em] text-neon-cyan/80">{t.shareRoom}</p>
                  </div>
                  <div className="flex flex-wrap justify-end gap-2">
                    <span className="rounded-full bg-black/25 px-3 py-1 text-[11px] font-medium text-white/85 backdrop-blur-sm">{visibilityLabel}</span>
                    <span className="rounded-full bg-black/25 px-3 py-1 text-[11px] font-medium text-white/85 backdrop-blur-sm">{accessLabel}</span>
                  </div>
                </div>
                <div className="absolute inset-x-0 bottom-0 p-5">
                  <div className="space-y-4">
                    <div className="flex items-center gap-4">
                      <div
                        className="flex h-16 w-16 items-center justify-center rounded-[20px] text-lg font-bold text-white/90 backdrop-blur-sm"
                        style={{ background: roomVisualTheme.accentDim, boxShadow: `0 0 0 1px ${roomVisualTheme.accent}55` }}
                      >
                        {roomInitials}
                      </div>
                      <div className="min-w-0">
                        <h2 className="truncate text-[34px] font-semibold leading-none text-white">{roomName}</h2>
                        <p className="mt-3 text-sm leading-6 text-white/72">{t.createShareAssets}</p>
                      </div>
                    </div>
                    {membersLoading ? (
                      <div className="flex items-center gap-2 overflow-hidden" aria-hidden="true">
                        {Array.from({ length: memberSkeletonCount }, (_, index) => (
                          <div
                            key={`member-skeleton-${index}`}
                            className="h-10 w-10 shrink-0 animate-pulse rounded-full bg-white/12"
                          />
                        ))}
                        <div className="h-10 w-16 shrink-0 animate-pulse rounded-full bg-white/10" />
                      </div>
                    ) : visibleMembers.length > 0 ? (
                      <div className="flex items-center gap-2 overflow-hidden">
                        {visibleMembers.map((member, index) => (
                          <div
                            key={member.agent_id}
                            className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-gradient-to-br ${memberAvatarTones[index % memberAvatarTones.length]} text-xs font-semibold text-white shadow-[0_8px_24px_rgba(0,0,0,0.28)]`}
                            title={member.display_name}
                          >
                            {initialsFromName(member.display_name || member.agent_id)}
                          </div>
                        ))}
                        {remainingMembers > 0 ? (
                          <div className="flex h-10 shrink-0 items-center justify-center rounded-full bg-white/[0.08] px-3 text-xs font-semibold text-white/80">
                            +{remainingMembers}
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                </div>
              </div>

              <div className="space-y-4 px-1 pt-5">
                {!canInvite ? (
                  <div className="space-y-3">
                    <button
                      onClick={() => void handleCopyText(typeof window !== "undefined" ? window.location.href : "", "plain-link")}
                      className="flex w-full items-start justify-between gap-4 rounded-2xl bg-black/20 px-4 py-4 text-left transition-colors hover:bg-white/5"
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
                      <span className="shrink-0 rounded-full bg-white/[0.07] px-3 py-1 text-[11px] font-medium text-text-primary/90">
                        {copiedField === "plain-link" ? tc.copied : tc.copy}
                      </span>
                    </button>
                  </div>
                ) : !shareData ? (
                    <div className="space-y-3">
                      <p className="text-sm leading-6 text-text-secondary">{t.shareSetupDescription}</p>
                      <button
                        onClick={handleCreate}
                        disabled={loading}
                        className="inline-flex w-full items-center justify-center gap-2 rounded-2xl bg-neon-cyan/15 px-4 py-3 text-sm font-medium text-neon-cyan transition-colors hover:bg-neon-cyan/20 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                        {loading ? t.creating : t.createShareLink}
                      </button>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      <button
                        onClick={() => void handleCopyPlainLink()}
                        className="flex w-full items-start justify-between gap-4 rounded-2xl bg-black/20 px-4 py-4 text-left transition-colors hover:bg-white/5"
                      >
                        <div className="flex items-start gap-3">
                          <div className="mt-0.5 rounded-xl bg-neon-cyan/12 p-2 text-neon-cyan">
                            <Link2 className="h-4 w-4" />
                          </div>
                          <div>
                            <p className="text-sm font-medium text-text-primary">{t.copyPlainLinkChannelTitle}</p>
                            <p className="mt-1 text-xs leading-5 text-text-secondary">{t.copyPlainLinkChannelDescription}</p>
                            {plainLinkUrl ? (
                              <p className="mt-2 max-w-[18rem] truncate text-[11px] leading-5 text-text-secondary/80">{plainLinkUrl}</p>
                            ) : null}
                          </div>
                        </div>
                        <span className="shrink-0 rounded-full bg-white/[0.07] px-3 py-1 text-[11px] font-medium text-text-primary/90">
                          {copiedField === "plain-link" ? tc.copied : tc.copy}
                        </span>
                      </button>
                    </div>
                  )
                }

                <div className="rounded-2xl bg-black/20 px-4 py-4">
                  <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-text-secondary/70">
                    {entryType === "private_invite" || roomVisibility === "private" ? <Lock className="h-3.5 w-3.5" /> : <Globe2 className="h-3.5 w-3.5" />}
                    {distributionLabel}
                  </div>
                  <p className="mt-2 text-sm leading-6 text-text-secondary">{statusNote}</p>
                </div>
              </div>
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}
