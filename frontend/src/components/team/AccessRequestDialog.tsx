"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, X } from "lucide-react";
import { useLanguage } from "@/lib/i18n";
import { spaceError, type AgentAccessRole } from "@/lib/team-spaces";
import { roleBadge, teamAccessApi, type DirectoryAgent } from "@/lib/team-access";
import { teamButton } from "./TeamConversationDialog";

export const teamDialogClass =
  "m-auto max-h-[90dvh] w-[calc(100%-1.5rem)] max-w-lg overflow-y-auto rounded-2xl border border-glass-border bg-deep-black p-5 text-text-primary shadow-xl backdrop:bg-black/50";

/** Ask an Agent's owner for read-only or collaborate access. */
export default function AccessRequestDialog({
  spaceId,
  agent,
  onClose,
  onSubmitted,
}: {
  spaceId: string;
  agent: DirectoryAgent;
  onClose: () => void;
  onSubmitted: () => void;
}) {
  const zh = useLanguage() === "zh";
  const t = (cn: string, en: string) => (zh ? cn : en);
  const dialog = useRef<HTMLDialogElement>(null);
  const mounted = useRef(false);
  // Already read-only: the only thing left to ask for is collaborate.
  const upgradeOnly = agent.my_access === "consultant";
  const [role, setRole] = useState<AgentAccessRole>(
    agent.pending_request?.requested_role ?? (upgradeOnly ? "collaborator" : "consultant"),
  );
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    mounted.current = true;
    dialog.current?.showModal?.();
    return () => {
      mounted.current = false;
    };
  }, []);

  async function submit() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await teamAccessApi.requestAccess(spaceId, agent.agent_id, role, message);
      if (mounted.current) onSubmitted();
    } catch (cause) {
      if (mounted.current) setError(cause);
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  const roles: AgentAccessRole[] = ["consultant", "collaborator"];
  return (
    <dialog
      ref={dialog}
      onCancel={onClose}
      aria-labelledby="access-request-title"
      className={teamDialogClass}
    >
      <form
        method="dialog"
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 id="access-request-title" className="text-lg font-semibold">
              {t("申请权限", "Request access")}
            </h2>
            <p className="mt-1 break-words text-sm text-text-secondary">
              {agent.display_name} · {t("所有者", "Owner")}: {agent.owner_name || "—"}
            </p>
          </div>
          <button
            type="button"
            className="rounded-lg p-2 hover:bg-glass-bg"
            aria-label={t("关闭", "Close")}
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </div>
        <fieldset className="space-y-2" disabled={busy}>
          <legend className="mb-2 text-sm">{t("你想怎么用它？", "How do you want to use it?")}</legend>
          {roles.map((value) => {
            const info = roleBadge(value, zh);
            const disabled = upgradeOnly && value === "consultant";
            return (
              <label
                key={value}
                className={`flex cursor-pointer items-start gap-3 rounded-xl border px-3 py-2.5 ${
                  role === value ? "border-neon-cyan/40 bg-neon-cyan/5" : "border-glass-border"
                } ${disabled ? "cursor-not-allowed opacity-50" : ""}`}
              >
                <input
                  type="radio"
                  name="access-role"
                  value={value}
                  checked={role === value}
                  disabled={disabled}
                  onChange={() => setRole(value)}
                  className="mt-1 accent-neon-cyan"
                />
                <span className="min-w-0">
                  <span className="block text-sm font-medium">{info.label}</span>
                  <span className="block text-xs leading-5 text-text-secondary">
                    {info.explanation}
                    {disabled ? t("（你已有此权限）", " (you already have this)") : ""}
                  </span>
                </span>
              </label>
            );
          })}
        </fieldset>
        <label className="block space-y-1.5 text-sm">
          <span>{t("留言（可选）", "Message (optional)")}</span>
          <textarea
            className="min-h-[76px] w-full resize-y rounded-xl border border-glass-border bg-deep-black px-3 py-2.5 text-sm outline-none focus:border-neon-cyan focus:ring-2 focus:ring-neon-cyan/20 disabled:opacity-50"
            value={message}
            maxLength={500}
            disabled={busy}
            onChange={(e) => setMessage(e.target.value)}
            placeholder={t("说明你想用它做什么", "Tell the owner what you need it for")}
          />
          <span className="block text-right text-[11px] text-text-secondary">{message.length}/500</span>
        </label>
        {error != null && (
          <p role="alert" className="rounded-xl border border-red-500/30 p-3 text-sm text-red-500">
            {spaceError(error, zh)}
          </p>
        )}
        <div className="flex flex-wrap justify-end gap-3">
          <button type="button" className={`${teamButton} flex-1 sm:flex-none`} onClick={onClose} disabled={busy}>
            {t("取消", "Cancel")}
          </button>
          <button
            type="submit"
            className={`${teamButton} flex-1 border-neon-cyan/30 bg-neon-cyan/10 text-neon-cyan sm:flex-none`}
            disabled={busy}
          >
            {busy && <Loader2 size={16} className="animate-spin" />}
            {agent.pending_request ? t("更新申请", "Update request") : t("发送申请", "Send request")}
          </button>
        </div>
      </form>
    </dialog>
  );
}
