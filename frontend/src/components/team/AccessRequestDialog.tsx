"use client";
import DashboardOverlayPortal from "@/components/dashboard/DashboardOverlayPortal";
import Button from "@/components/ui/Button";
import DialogShell from "@/components/ui/DialogShell";
import Field from "@/components/ui/Field";
import { Textarea } from "@/components/ui/Input";

import Alert from "@/components/ui/Alert";
import Radio from "@/components/ui/Radio";
import { useLanguage } from "@/lib/i18n";
import {
  roleBadge,
  teamAccessApi,
  type DirectoryAgent,
} from "@/lib/team-access";
import { spaceError, type AgentAccessRole } from "@/lib/team-spaces";
import { Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

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
  const mounted = useRef(false);
  // Already read-only: the only thing left to ask for is collaborate.
  const upgradeOnly = agent.my_access === "consultant";
  const [role, setRole] = useState<AgentAccessRole>(
    agent.pending_request?.requested_role ??
      (upgradeOnly ? "collaborator" : "consultant"),
  );
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    mounted.current = true;
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
    <DashboardOverlayPortal>
      <DialogShell
        size="lg"
        title={<>{t("申请权限", "Request access")}</>}
        onClose={onClose}
        busy={busy}
        closeLabel={zh ? "关闭" : "Close"}
      >
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="mt-1 break-words text-sm text-text-secondary">
                {agent.display_name} · {t("所有者", "Owner")}:{" "}
                {agent.owner_name || "—"}
              </p>
            </div>
          </div>
          <fieldset className="space-y-2" disabled={busy}>
            <legend className="mb-2 text-sm">
              {t("你想怎么用它？", "How do you want to use it?")}
            </legend>
            {roles.map((value) => {
              const info = roleBadge(value, zh);
              const disabled = upgradeOnly && value === "consultant";
              return (
                <label
                  key={value}
                  className={`flex cursor-pointer items-start gap-3 rounded-xl border px-3 py-2.5 ${
                    role === value
                      ? "border-neon-cyan/40 bg-neon-cyan/5"
                      : "border-glass-border"
                  } ${disabled ? "cursor-not-allowed opacity-50" : ""}`}
                >
                  <Radio
                    name="access-role"
                    value={value}
                    checked={role === value}
                    disabled={disabled}
                    onChange={() => setRole(value)}
                    className="mt-1 accent-neon-cyan"
                  />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium">
                      {info.label}
                    </span>
                    <span className="block text-xs leading-5 text-text-secondary">
                      {info.explanation}
                      {disabled
                        ? t("（你已有此权限）", " (you already have this)")
                        : ""}
                    </span>
                  </span>
                </label>
              );
            })}
          </fieldset>
          <Field
            label={<>{t("留言（可选）", "Message (optional)")}</>}
            hint={
              <>
                <span className="block text-right text-xs text-text-secondary">
                  {message.length}/500
                </span>
              </>
            }
          >
            <Textarea
              className="min-h-[76px] w-full resize-y"
              value={message}
              maxLength={500}
              disabled={busy}
              onChange={(e) => setMessage(e.target.value)}
              placeholder={t(
                "说明你想用它做什么",
                "Tell the owner what you need it for",
              )}
            />
          </Field>
          {error != null && (
            <Alert tone="danger">{spaceError(error, zh)}</Alert>
          )}
          <div className="flex flex-wrap justify-end gap-3">
            <Button
              variant="secondary"
              type="button"
              className="flex-1 sm:flex-none"
              onClick={onClose}
              disabled={busy}
            >
              {t("取消", "Cancel")}
            </Button>
            <Button
              variant="primary"
              type="submit"
              className="flex-1 sm:flex-none"
              disabled={busy}
            >
              {busy && <Loader2 size={16} className="animate-spin" />}
              {agent.pending_request
                ? t("更新申请", "Update request")
                : t("发送申请", "Send request")}
            </Button>
          </div>
        </form>
      </DialogShell>
    </DashboardOverlayPortal>
  );
}
