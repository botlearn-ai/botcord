"use client";

import { withDashboardOverlayPortal } from "./DashboardOverlayPortal";
/**
 * [INPUT]: 依赖 dashboard i18n 文案、contacts API 与 CopyableId 展示 DM 对侧或自有 Agent 的身份信息
 * [OUTPUT]: 对外提供 DMSettingsModal 组件，渲染私聊设置弹窗并支持解除好友关系
 * [POS]: dashboard 消息视图的 DM 设置面板，承接“查看身份信息/移除联系人”动作
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { animatePop, cleanupAnime } from "@/lib/anime";
import { useLanguage } from "@/lib/i18n";
import { dmSettingsModal } from "@/lib/i18n/translations/dashboard";
import { api } from "@/lib/api";
import Button from "@/components/ui/Button";
import CopyableId from "@/components/ui/CopyableId";
import DialogShell, { useDialogClose } from "@/components/ui/DialogShell";
import type { ContactInfo } from "@/lib/types";

interface DMSettingsModalProps {
  /** The contact on the other side of this DM. null when chatting with own agent. */
  contact: ContactInfo | null;
  /** Display name for own agent (used when contact is null). */
  ownAgentName?: string;
  /** Agent ID for own agent (used when contact is null). */
  ownAgentId?: string;
  onClose: () => void;
  /** Called after the contact has been successfully removed. */
  onContactRemoved?: () => void;
}

export default withDashboardOverlayPortal(DMSettingsModal);

function DMSettingsModal({
  contact,
  ownAgentName,
  ownAgentId,
  onClose,
  onContactRemoved,
}: DMSettingsModalProps) {
  const locale = useLanguage();
  const t = dmSettingsModal[locale];
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const errorRef = useRef<HTMLDivElement>(null);
  const removeButtonRef = useRef<HTMLButtonElement>(null);
  const feedbackAnimationRef = useRef<ReturnType<typeof animatePop>>(null);

  const isOwnAgent = contact === null;
  const title = isOwnAgent ? t.titleMyAgent : t.titleFriend;

  useEffect(() => {
    const target = error ? errorRef.current : confirming ? removeButtonRef.current : null;
    if (!target) return;
    cleanupAnime(feedbackAnimationRef.current);
    feedbackAnimationRef.current = animatePop(target);
    return () => cleanupAnime(feedbackAnimationRef.current);
  }, [confirming, error]);

  return (
    <DialogShell
      title={title}
      size="sm"
      busy={removing}
      onClose={onClose}
      hideCloseButton
      overlayClassName="z-50 backdrop-blur-sm"
      bodyClassName="space-y-4"
      footer={(close) => (
        <>
          {!isOwnAgent && (
            <RemoveFriendButton
              buttonRef={removeButtonRef}
              contact={contact}
              confirming={confirming}
              removing={removing}
              labels={t}
              onContactRemoved={onContactRemoved}
              setConfirming={setConfirming}
              setRemoving={setRemoving}
              setError={setError}
            />
          )}
          <Button variant="ghost" onClick={close} className="ml-auto">
            {t.close}
          </Button>
        </>
      )}
    >
      {error && (
        <div ref={errorRef} className="rounded-lg border border-danger/25 bg-danger-soft px-3 py-2 text-sm text-danger">
          {error}
        </div>
      )}

      {isOwnAgent ? (
        <div className="liquid-card space-y-3 rounded-xl border p-3">
          <div>
            <p className="mb-1 text-xs font-semibold uppercase tracking-[0.16em] text-text-secondary/70">
              {t.displayName}
            </p>
            <p className="text-sm text-text-primary">{ownAgentName ?? "—"}</p>
          </div>
          <div>
            <p className="mb-1 text-xs font-semibold uppercase tracking-[0.16em] text-text-secondary/70">
              {t.agentId}
            </p>
            <CopyableId value={ownAgentId ?? ""} />
          </div>
        </div>
      ) : (
        <div className="liquid-card space-y-3 rounded-xl border p-3">
          <div>
            <p className="mb-1 text-xs font-semibold uppercase tracking-[0.16em] text-text-secondary/70">
              {t.displayName}
            </p>
            <p className="text-sm text-text-primary">{contact!.display_name}</p>
          </div>
          <div>
            <p className="mb-1 text-xs font-semibold uppercase tracking-[0.16em] text-text-secondary/70">
              {t.agentId}
            </p>
            <CopyableId value={contact!.contact_agent_id} />
          </div>
        </div>
      )}
    </DialogShell>
  );
}

// Lives inside DialogShell so it can close the dialog with its exit animation
// once the contact is removed. First click arms the confirmation.
function RemoveFriendButton({
  buttonRef,
  contact,
  confirming,
  removing,
  labels,
  onContactRemoved,
  setConfirming,
  setRemoving,
  setError,
}: {
  buttonRef: RefObject<HTMLButtonElement | null>;
  contact: ContactInfo | null;
  confirming: boolean;
  removing: boolean;
  labels: (typeof dmSettingsModal)[keyof typeof dmSettingsModal];
  onContactRemoved?: () => void;
  setConfirming: (confirming: boolean) => void;
  setRemoving: (removing: boolean) => void;
  setError: (error: string | null) => void;
}) {
  const closeDialog = useDialogClose();

  const handleRemove = async () => {
    if (!contact) return;
    if (!confirming) {
      setConfirming(true);
      return;
    }
    setRemoving(true);
    setError(null);
    try {
      await api.removeContact(contact.contact_agent_id);
      onContactRemoved?.();
      closeDialog();
    } catch (err) {
      setError(err instanceof Error ? err.message : labels.removeFriendFailed);
      setConfirming(false);
    } finally {
      setRemoving(false);
    }
  };

  return (
    <Button
      ref={buttonRef}
      variant="danger"
      onClick={() => void handleRemove()}
      loading={removing}
    >
      {confirming
        ? removing ? labels.removingFriend : labels.removeFriendConfirm
        : labels.removeFriend}
    </Button>
  );
}
