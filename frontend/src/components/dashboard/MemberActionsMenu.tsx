"use client";

/**
 * [INPUT]: 接收当前房间、目标成员、调用者角色，依赖 humansApi 调用 Phase 4 moderator endpoints
 * [OUTPUT]: 对外提供 MemberActionsMenu — 成员行上的 Promote/Demote/Permissions/Remove 入口
 * [POS]: AgentBrowser 成员列表的右侧交互层，Phase 7 将 Phase 4 的 moderator wrappers 收拢到单点 UI
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

import DialogShell, { useDialogClose } from "@/components/ui/DialogShell";
import Menu, { MenuTrigger, MenuContent, MenuItem } from "@/components/ui/Menu";
import IconButton from "@/components/ui/IconButton";
import { MoreHorizontal } from "lucide-react";
import Tabs from "@/components/ui/Tabs";
import Button from "@/components/ui/Button";
import { useState } from "react";
import type { PublicRoomMember } from "@/lib/types";
import { humansApi } from "@/lib/api";
import { useLanguage } from "@/lib/i18n";
import { agentBrowser } from "@/lib/i18n/translations/dashboard";
import { useConfirm } from "@/store/useConfirmStore";
import { withDashboardOverlayPortal } from "./DashboardOverlayPortal";

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
  const confirm = useConfirm();
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
    if (!(await confirm({ title: t.removeMemberConfirm, tone: "danger" }))) return;
    try {
      await humansApi.removeRoomMember(roomId, member.agent_id);
      onMutated();
    } catch (e: any) {
      onError(e?.message || t.removeMemberFailed);
    }
  });

  return (
    <div className="relative ml-1 shrink-0">
      <Menu open={open} onOpenChange={setOpen}>
        <MenuTrigger asChild><IconButton label={t.memberActions} size="sm" disabled={busy}><MoreHorizontal size={16} strokeWidth={1.75} /></IconButton></MenuTrigger>
        <MenuContent align="end">
          {canPromoteDemote && <MenuItem disabled={busy} onSelect={() => void toggleRole()}>{member.role === "admin" ? t.demoteToMember : t.promoteToAdmin}</MenuItem>}
          {canEditPerms && <MenuItem disabled={busy} onSelect={() => { setPermOpen(true); setOpen(false); }}>{t.editPermissions}</MenuItem>}
          {canRemove && <MenuItem danger disabled={busy} onSelect={() => void doRemove()}>{t.removeMember}</MenuItem>}
        </MenuContent>
      </Menu>
      {permOpen && (
        <PortaledPermissionsDialog
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

function PermissionsContent({
  roomId, member, onClose, onSaved, onError, setBusy,
}: {
  roomId: string;
  member: PublicRoomMember;
  onClose: () => void;
  onSaved: () => void;
  onError: (msg: string) => void;
  setBusy: (busy: boolean) => void;
}) {
  const locale = useLanguage();
  const t = agentBrowser[locale];
  // Prefill from the server's current override state so Save-without-edits
  // is a no-op, not an accidental wipe. Missing fields fall back to ``null``
  // ("use room default").
  const [canSend, setCanSend] = useState<boolean | null>(member.can_send ?? null);
  const [canInvite, setCanInvite] = useState<boolean | null>(member.can_invite ?? null);
  const [saving, setSaving] = useState(false);
  const closeWithMotion = useDialogClose();

  const save = async () => {
    if (saving) return;
    setSaving(true);
    setBusy(true);
    try {
      await humansApi.setRoomMemberPermissions(roomId, member.agent_id, {
        can_send: canSend,
        can_invite: canInvite,
      });
      onSaved();
      closeWithMotion();
    } catch (e: any) {
      onError(e?.message || t.permSaveFailed);
    } finally {
      setSaving(false);
      setBusy(false);
    }
  };

  return (
    <>
        <TriToggle label={t.permCanSend} value={canSend} onChange={setCanSend} t={t} />
        <TriToggle label={t.permCanInvite} value={canInvite} onChange={setCanInvite} t={t} />
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" size="sm"
            onClick={closeWithMotion}
            disabled={saving}

          >
            {t.permCancel}
          </Button>
          <Button variant="secondary" size="sm"
            onClick={save}
            disabled={saving}
            className="disabled:opacity-50"
          >
            {saving ? "…" : t.permSave}
          </Button>
        </div>
    </>
  );
}

function PermissionsDialog(props: { roomId: string; member: PublicRoomMember; onClose: () => void; onSaved: () => void; onError: (message: string) => void }) {
  const locale = useLanguage();
  const [busy, setBusy] = useState(false);
  return <DialogShell title={`${agentBrowser[locale].permissionsTitle} — ${props.member.display_name}`} size="sm" busy={busy} onClose={props.onClose}>
    <PermissionsContent {...props} setBusy={setBusy} />
  </DialogShell>;
}

const PortaledPermissionsDialog = withDashboardOverlayPortal(PermissionsDialog, "nested");

function TriToggle({
  label, value, onChange, t,
}: {
  label: string;
  value: boolean | null;
  onChange: (v: boolean | null) => void;
  t: { permUseDefault: string; permAllow: string; permDeny: string };
}) {
  return (
    <div className="mb-3">
      <p className="mb-1 type-caption text-text-secondary">{label}</p>
      <Tabs
        ariaLabel={label}
        value={value === null ? "default" : value ? "allow" : "deny"}
        onValueChange={(next) => onChange(next === "default" ? null : next === "allow")}
        size="sm"
        items={[{ value: "default", label: t.permUseDefault }, { value: "allow", label: t.permAllow }, { value: "deny", label: t.permDeny }]}
      />
    </div>
  );
}
