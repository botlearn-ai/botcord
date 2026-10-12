"use client";

import { withDashboardOverlayPortal } from "./DashboardOverlayPortal";
/**
 * [INPUT]: 接收当前房间、候选成员列表与关闭回调，依赖 humansApi.transferRoomOwnership 执行转让
 * [OUTPUT]: 对外提供 TransferOwnershipDialog — 下拉选择 + 二次文字确认的转让房主弹窗
 * [POS]: AgentBrowser 房间操作区，取代 window.prompt，Phase 8 P0 的转让安全网
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

import { useMemo, useState } from "react";
import type { PublicRoomMember } from "@/lib/types";
import { humansApi } from "@/lib/api";
import Button from "@/components/ui/Button";
import DialogShell, { useDialogClose } from "@/components/ui/DialogShell";
import { Input } from "@/components/ui/Input";
import { useLanguage } from "@/lib/i18n";
import { agentBrowser } from "@/lib/i18n/translations/dashboard";
import DashboardSelect from "./DashboardSelect";

interface Props {
  roomId: string;
  roomName: string;
  viewerHumanId: string;
  members: PublicRoomMember[];
  onClose: () => void;
  onSuccess: () => void;
  onError: (msg: string) => void;
}

export default withDashboardOverlayPortal(TransferOwnershipDialog, "nested");

function TransferOwnershipDialog({
  roomId, roomName, viewerHumanId, members, onClose, onSuccess, onError,
}: Props) {
  const locale = useLanguage();
  const t = agentBrowser[locale];

  // Candidates = every member except the caller and the current owner (who
  // is the caller, given we only render this for owners). Sorted admins
  // first so the "most natural successor" floats up.
  const candidates = useMemo(
    () => members
      .filter((m) => m.agent_id !== viewerHumanId && m.role !== "owner")
      .sort((a, b) => (a.role === "admin" ? -1 : 1) - (b.role === "admin" ? -1 : 1)),
    [members, viewerHumanId],
  );

  const [selectedId, setSelectedId] = useState<string>(candidates[0]?.agent_id ?? "");
  const [confirmText, setConfirmText] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const selected = candidates.find((c) => c.agent_id === selectedId);
  // Require the user to type the room name exactly — this is a
  // non-reversible action and the blast radius is losing ownership.
  const confirmArmed = confirmText.trim() === roomName.trim();

  return (
    <DialogShell
      title={t.transferOwnership}
      busy={submitting}
      onClose={onClose}
      hideCloseButton
      overlayClassName="z-30"
      className="max-w-[360px]"
      footer={(close) => (
        <>
          <Button variant="ghost" size="sm" onClick={close} disabled={submitting}>
            {t.permCancel}
          </Button>
          {candidates.length > 0 && (
            <TransferSubmitButton
              roomId={roomId}
              selected={selected}
              confirmArmed={confirmArmed}
              submitting={submitting}
              label={submitting ? "…" : t.transferOwnership}
              failedMessage={t.transferFailed}
              onSuccess={onSuccess}
              onError={onError}
              setSubmitting={setSubmitting}
            />
          )}
        </>
      )}
    >
      {candidates.length === 0 ? (
        <p className="text-xs text-text-secondary">{t.transferPromptNoCandidate}</p>
      ) : (
        <>
          <label className="mb-3 block">
            <span className="mb-1 block text-xs text-text-secondary">
              {t.transferSelectLabel}
            </span>
            <DashboardSelect
              value={selectedId}
              onChange={(value) => {
                if (value) setSelectedId(value);
              }}
              placeholder={t.transferSelectLabel}
              buttonClassName="min-h-9 rounded px-2 text-xs"
              options={candidates.map((c) => ({
                value: c.agent_id,
                label: c.display_name,
                sublabel: `${c.agent_id.startsWith("hu_") ? "H" : "A"} · ${c.role} · ${c.agent_id}`,
              }))}
            />
          </label>

          <label className="mb-3 block">
            <span className="mb-1 block text-xs text-text-secondary">
              {t.transferConfirmLabel.replace("{room}", roomName)}
            </span>
            <Input
              type="text"
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder={roomName}
            />
          </label>

          <p className="text-xs leading-5 text-warning">
            {t.transferWarning}
          </p>
        </>
      )}
    </DialogShell>
  );
}

// Lives inside DialogShell so it can close the dialog with its exit animation
// once the transfer succeeds.
function TransferSubmitButton({
  roomId,
  selected,
  confirmArmed,
  submitting,
  label,
  failedMessage,
  onSuccess,
  onError,
  setSubmitting,
}: {
  roomId: string;
  selected: PublicRoomMember | undefined;
  confirmArmed: boolean;
  submitting: boolean;
  label: string;
  failedMessage: string;
  onSuccess: () => void;
  onError: (msg: string) => void;
  setSubmitting: (submitting: boolean) => void;
}) {
  const closeDialog = useDialogClose();

  const submit = async () => {
    if (!selected || !confirmArmed || submitting) return;
    setSubmitting(true);
    try {
      await humansApi.transferRoomOwnership(roomId, selected.agent_id);
      onSuccess();
      closeDialog();
    } catch (e: any) {
      onError(e?.message || failedMessage);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Button
      variant="primary"
      size="sm"
      onClick={submit}
      disabled={!confirmArmed || !selected || submitting}
    >
      {label}
    </Button>
  );
}
