"use client";

/**
 * [INPUT]: 接收当前房间、目标成员、调用者角色，依赖 humansApi 调用 Phase 4 moderator endpoints
 * [OUTPUT]: 对外提供 MemberActionsMenu — 成员行上的 Promote/Demote/Permissions/Remove 入口
 * [POS]: AgentBrowser 成员列表的右侧交互层，Phase 7 将 Phase 4 的 moderator wrappers 收拢到单点 UI
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

import { useState } from "react";
import type { PublicRoomMember } from "@/lib/types";
import { humansApi } from "@/lib/api";
import { useLanguage } from "@/lib/i18n";
import { agentBrowser } from "@/lib/i18n/translations/dashboard";

interface Props {
  roomId: string;
  member: PublicRoomMember;
  viewerRole: "owner" | "admin" | "member" | string;
  /** Fired on any successful mutation so the parent can refetch the list. */
  onMutated: () => void;
  /** Fired on errors — parent shows them in a shared banner. */
  onError: (msg: string) => void;
}

export default function MemberActionsMenu({
  roomId, member, viewerRole, onMutated, onError,
}: Props) {
  const locale = useLanguage();
  const t = agentBrowser[locale];
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [permOpen, setPermOpen] = useState(false);

  const isOwner = viewerRole === "owner";
  const isOwnerTarget = member.role === "owner";
  const isAdminTarget = member.role === "admin";

  const canPromoteDemote = isOwner && !isOwnerTarget;
  // Admin can edit perms for plain members; owner can edit perms for non-owner.
  const canEditPerms = !isOwnerTarget && (isOwner || (viewerRole === "admin" && !isAdminTarget));
  // Already surfaced by the outer ✕ — this menu focuses on role + perms;
  // include Remove here too for a single unified surface.
  const canRemove = !isOwnerTarget && (isOwner || (viewerRole === "admin" && !isAdminTarget));

  if (!canPromoteDemote && !canEditPerms && !canRemove) return null;

  const guard = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    try { await fn(); } finally { setBusy(false); setOpen(false); }
  };

  const toggleRole = () => guard(async () => {
    const next = member.role === "admin" ? "member" : "admin";
    try {
      await humansApi.promoteRoomMember(roomId, member.agent_id, next);
      onMutated();
    } catch (e: any) {
      onError(e?.message || t.promoteFailed);
    }
  });

  const doRemove = () => guard(async () => {
    if (!window.confirm(t.removeMemberConfirm)) return;
    try {
      await humansApi.removeRoomMember(roomId, member.agent_id);
      onMutated();
    } catch (e: any) {
      onError(e?.message || t.removeMemberFailed);
    }
  });

  return (
    <div className="relative ml-1 shrink-0">
      <button
        onClick={() => setOpen((v) => !v)}
        disabled={busy}
        title={t.memberActions}
        className="rounded px-1 py-0.5 text-[12px] leading-none text-text-secondary/70 transition-colors hover:bg-glass-bg hover:text-text-primary disabled:opacity-40"
      >
        ⋯
      </button>
      {open && (
        <div className="absolute right-0 z-20 mt-1 min-w-[140px] rounded-md border border-glass-border bg-deep-black-light p-1 shadow-lg">
          {canPromoteDemote && (
            <button
              onClick={toggleRole}
              className="block w-full rounded px-2 py-1.5 text-left text-[11px] text-text-primary hover:bg-glass-bg"
            >
              {member.role === "admin" ? t.demoteToMember : t.promoteToAdmin}
            </button>
          )}
          {canEditPerms && (
            <button
              onClick={() => { setPermOpen(true); setOpen(false); }}
              className="block w-full rounded px-2 py-1.5 text-left text-[11px] text-text-primary hover:bg-glass-bg"
            >
              {t.editPermissions}
            </button>
          )}
          {canRemove && (
            <button
              onClick={doRemove}
              className="block w-full rounded px-2 py-1.5 text-left text-[11px] text-red-300 hover:bg-red-500/10"
            >
              {t.removeMember}
            </button>
          )}
        </div>
      )}
      {permOpen && (
        <PermissionsDialog
          roomId={roomId}
          member={member}
          onClose={() => setPermOpen(false)}
          onSaved={onMutated}
          onError={onError}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inline permissions dialog. Tri-state per field: null (default), true, false.
// ---------------------------------------------------------------------------

function PermissionsDialog({
  roomId, member, onClose, onSaved, onError,
}: {
  roomId: string;
  member: PublicRoomMember;
  onClose: () => void;
  onSaved: () => void;
  onError: (msg: string) => void;
}) {
  const locale = useLanguage();
  const t = agentBrowser[locale];
  // Prefill from the server's current override state so Save-without-edits
  // is a no-op, not an accidental wipe. Missing fields fall back to ``null``
  // ("use room default").
  const [canSend, setCanSend] = useState<boolean | null>(member.can_send ?? null);
  const [canInvite, setCanInvite] = useState<boolean | null>(member.can_invite ?? null);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (saving) return;
    setSaving(true);
    try {
      await humansApi.setRoomMemberPermissions(roomId, member.agent_id, {
        can_send: canSend,
        can_invite: canInvite,
      });
      onSaved();
      onClose();
    } catch (e: any) {
      onError(e?.message || t.permSaveFailed);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-30 flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        className="w-[320px] rounded-lg border border-glass-border bg-deep-black-light p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="mb-3 text-sm font-semibold text-text-primary">
          {t.permissionsTitle} — {member.display_name}
        </h3>
        <TriToggle label={t.permCanSend} value={canSend} onChange={setCanSend} t={t} />
        <TriToggle label={t.permCanInvite} value={canInvite} onChange={setCanInvite} t={t} />
        <div className="mt-4 flex justify-end gap-2">
          <button
            onClick={onClose}
            disabled={saving}
            className="rounded border border-glass-border px-3 py-1.5 text-[11px] text-text-secondary hover:bg-glass-bg"
          >
            {t.permCancel}
          </button>
          <button
            onClick={save}
            disabled={saving}
            className="rounded border border-neon-cyan/40 bg-neon-cyan/10 px-3 py-1.5 text-[11px] text-neon-cyan hover:bg-neon-cyan/20 disabled:opacity-50"
          >
            {saving ? "…" : t.permSave}
          </button>
        </div>
      </div>
    </div>
  );
}

function TriToggle({
  label, value, onChange, t,
}: {
  label: string;
  value: boolean | null;
  onChange: (v: boolean | null) => void;
  t: { permUseDefault: string; permAllow: string; permDeny: string };
}) {
  const base = "px-2 py-1 text-[10px] rounded border transition-colors";
  const sel = "border-neon-cyan/40 bg-neon-cyan/10 text-neon-cyan";
  const off = "border-glass-border text-text-secondary hover:bg-glass-bg";
  return (
    <div className="mb-3">
      <p className="mb-1 text-[11px] text-text-secondary">{label}</p>
      <div className="flex gap-1">
        <button className={`${base} ${value === null ? sel : off}`} onClick={() => onChange(null)}>
          {t.permUseDefault}
        </button>
        <button className={`${base} ${value === true ? sel : off}`} onClick={() => onChange(true)}>
          {t.permAllow}
        </button>
        <button className={`${base} ${value === false ? sel : off}`} onClick={() => onChange(false)}>
          {t.permDeny}
        </button>
      </div>
    </div>
  );
}
