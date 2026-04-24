"use client";

/**
 * [INPUT]: 接收当前房间、候选成员列表与关闭回调，依赖 humansApi.transferRoomOwnership 执行转让
 * [OUTPUT]: 对外提供 TransferOwnershipDialog — 下拉选择 + 二次文字确认的转让房主弹窗
 * [POS]: AgentBrowser 房间操作区，取代 window.prompt，Phase 8 P0 的转让安全网
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

import { useMemo, useState } from "react";
import type { PublicRoomMember } from "@/lib/types";
import { humansApi } from "@/lib/api";
import { useLanguage } from "@/lib/i18n";
import { agentBrowser } from "@/lib/i18n/translations/dashboard";

interface Props {
  roomId: string;
  roomName: string;
  viewerHumanId: string;
  members: PublicRoomMember[];
  onClose: () => void;
  onSuccess: () => void;
  onError: (msg: string) => void;
}

export default function TransferOwnershipDialog({
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

  const submit = async () => {
    if (!selected || !confirmArmed || submitting) return;
    setSubmitting(true);
    try {
      await humansApi.transferRoomOwnership(roomId, selected.agent_id);
      onSuccess();
      onClose();
    } catch (e: any) {
      onError(e?.message || t.transferFailed);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-30 flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        className="w-[360px] rounded-lg border border-glass-border bg-deep-black-light p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="mb-3 text-sm font-semibold text-text-primary">
          {t.transferOwnership}
        </h3>

        {candidates.length === 0 ? (
          <p className="text-xs text-text-secondary">{t.transferPromptNoCandidate}</p>
        ) : (
          <>
            <label className="mb-3 block">
              <span className="mb-1 block text-[11px] text-text-secondary">
                {t.transferSelectLabel}
              </span>
              <select
                value={selectedId}
                onChange={(e) => setSelectedId(e.target.value)}
                className="w-full rounded border border-glass-border bg-deep-black px-2 py-1.5 text-xs text-text-primary"
              >
                {candidates.map((c) => (
                  <option key={c.agent_id} value={c.agent_id}>
                    {c.display_name} · {c.agent_id.startsWith("hu_") ? "H" : "A"} · {c.role}
                  </option>
                ))}
              </select>
            </label>

            <label className="mb-3 block">
              <span className="mb-1 block text-[11px] text-text-secondary">
                {t.transferConfirmLabel.replace("{room}", roomName)}
              </span>
              <input
                type="text"
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                placeholder={roomName}
                className="w-full rounded border border-glass-border bg-deep-black px-2 py-1.5 text-xs text-text-primary placeholder:text-text-secondary/40"
              />
            </label>

            <p className="mb-3 text-[11px] leading-5 text-yellow-300/80">
              {t.transferWarning}
            </p>
          </>
        )}

        <div className="mt-1 flex justify-end gap-2">
          <button
            onClick={onClose}
            disabled={submitting}
            className="rounded border border-glass-border px-3 py-1.5 text-[11px] text-text-secondary hover:bg-glass-bg"
          >
            {t.permCancel}
          </button>
          {candidates.length > 0 && (
            <button
              onClick={submit}
              disabled={!confirmArmed || !selected || submitting}
              className="rounded border border-neon-purple/40 bg-neon-purple/10 px-3 py-1.5 text-[11px] text-neon-purple hover:bg-neon-purple/20 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {submitting ? "…" : t.transferOwnership}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
