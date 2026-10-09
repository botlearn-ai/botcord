"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Inbox, Loader2, X } from "lucide-react";
import { useLanguage } from "@/lib/i18n";
import { spaceError, type AgentAccessRole } from "@/lib/team-spaces";
import {
  GRANT_DURATIONS,
  MAX_ALLOWED_COMMANDS,
  isValidWorkspacePath,
  parseAllowedCommands,
  type GrantDuration,
} from "@/lib/agent-access";
import { buildApproveInput, roleBadge, teamAccessApi, type AccessRequest } from "@/lib/team-access";
import { useConfirm } from "@/store/useConfirmStore";
import { useToDecide, useTeamAccessStore } from "@/store/useTeamAccessStore";
import { teamButton } from "./TeamConversationDialog";
import AccessBadge from "./AccessBadge";
import { teamDialogClass } from "./AccessRequestDialog";

const field =
  "w-full rounded-xl border border-glass-border bg-deep-black px-3 py-2.5 text-sm text-text-primary outline-none focus:border-neon-cyan focus:ring-2 focus:ring-neon-cyan/20 disabled:opacity-50";
const small =
  "inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg border border-glass-border px-3 py-1.5 text-xs transition-colors hover:bg-neon-cyan/10 focus-visible:outline-2 focus-visible:outline-neon-cyan disabled:cursor-not-allowed disabled:opacity-50";

/**
 * Owner inbox: pending requests to use the caller's Agents. Reads the shared
 * store (also behind the Team nav badge) and refreshes it after each decision.
 */
export default function AccessRequestsInbox({
  spaceId,
  agentId,
  agentNames,
  onDecided,
  hideWhenEmpty = false,
}: {
  spaceId: string;
  /** Only requests for this Agent. */
  agentId?: string;
  agentNames: Record<string, string>;
  onDecided?: () => void;
  hideWhenEmpty?: boolean;
}) {
  const zh = useLanguage() === "zh";
  const t = (cn: string, en: string) => (zh ? cn : en);
  const confirm = useConfirm();
  const mounted = useRef(false);
  const all = useToDecide(spaceId);
  const requests = agentId ? all.filter((r) => r.agent_id === agentId) : all;
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [approving, setApproving] = useState<AccessRequest | null>(null);

  useEffect(() => {
    mounted.current = true;
    void useTeamAccessStore
      .getState()
      .refreshToDecide(spaceId)
      .finally(() => mounted.current && setLoaded(true));
    return () => {
      mounted.current = false;
    };
  }, [spaceId]);

  const done = async () => {
    await useTeamAccessStore.getState().refreshToDecide(spaceId);
    onDecided?.();
  };
  async function reject(request: AccessRequest) {
    if (busy) return;
    const ok = await confirm({
      title: `${t("拒绝申请", "Decline request")}: ${request.requester_name || "—"}`,
      message: t(
        `对方将看到申请被拒绝，之后仍可重新申请使用 ${agentNames[request.agent_id] ?? request.agent_id}。`,
        `They'll see the request was declined and can ask again for ${agentNames[request.agent_id] ?? request.agent_id}.`,
      ),
      confirmLabel: t("拒绝", "Decline"),
      tone: "danger",
    });
    if (!ok || !mounted.current) return;
    setBusy(request.id);
    setError(null);
    try {
      await teamAccessApi.reject(spaceId, request.id);
      await done();
    } catch (cause) {
      if (mounted.current) setError(cause);
    } finally {
      if (mounted.current) setBusy(null);
    }
  }

  if (hideWhenEmpty && !requests.length && error == null) return null;
  return (
    <div className="space-y-2" aria-label={t("待处理的权限申请", "Pending access requests")}>
      <h3 className="flex items-center gap-2 text-sm font-medium">
        <Inbox size={16} />
        {t("待处理的权限申请", "Pending access requests")} · {requests.length}
      </h3>
      {error != null && (
        <p role="alert" className="text-sm text-red-500">
          {spaceError(error, zh)}
        </p>
      )}
      {!loaded && !requests.length ? (
        <p role="status" className="flex items-center gap-2 text-xs text-text-secondary">
          <Loader2 size={14} className="animate-spin" />
          {t("正在加载申请…", "Loading requests…")}
        </p>
      ) : !requests.length ? (
        <p className="text-xs text-text-secondary">{t("没有待处理的申请。", "No pending requests.")}</p>
      ) : (
        <ul className="divide-y divide-glass-border rounded-xl border border-glass-border">
          {requests.map((request) => (
            <li key={request.id} className="flex flex-wrap items-start justify-between gap-3 p-3">
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="break-words font-medium">{request.requester_name || request.requester_human_id || "—"}</span>
                  <span className="text-text-secondary">{t("申请", "asks for")}</span>
                  <AccessBadge info={roleBadge(request.requested_role, zh)} />
                </p>
                <p className="mt-1 break-words text-xs text-text-secondary">
                  {agentNames[request.agent_id] ?? request.agent_id} ·{" "}
                  {new Date(request.created_at).toLocaleString(zh ? "zh-CN" : "en-US", {
                    dateStyle: "medium",
                    timeStyle: "short",
                  })}
                </p>
                {request.message && (
                  <p className="mt-2 whitespace-pre-wrap break-words rounded-lg bg-glass-bg px-3 py-2 text-xs leading-5">
                    {request.message}
                  </p>
                )}
              </div>
              <div className="flex w-full justify-end gap-2 sm:w-auto">
                <button
                  className={`${small} text-red-500`}
                  disabled={busy != null}
                  onClick={() => void reject(request)}
                >
                  {busy === request.id ? <Loader2 size={13} className="animate-spin" /> : <X size={13} />}
                  {t("拒绝", "Decline")}
                </button>
                <button
                  className={`${small} border-neon-cyan/30 text-neon-cyan`}
                  disabled={busy != null}
                  onClick={() => setApproving(request)}
                >
                  <Check size={13} />
                  {t("批准", "Approve")}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {approving && (
        <ApproveRequestDialog
          spaceId={spaceId}
          request={approving}
          agentName={agentNames[approving.agent_id] ?? approving.agent_id}
          onClose={() => setApproving(null)}
          onApproved={async () => {
            setApproving(null);
            await done();
          }}
        />
      )}
    </div>
  );
}

/** Confirm an approval: role (prefilled from the request), expiry, and collaborator limits. */
export function ApproveRequestDialog({
  spaceId,
  request,
  agentName,
  onClose,
  onApproved,
}: {
  spaceId: string;
  request: AccessRequest;
  agentName: string;
  onClose: () => void;
  onApproved: () => void | Promise<void>;
}) {
  const zh = useLanguage() === "zh";
  const t = (cn: string, en: string) => (zh ? cn : en);
  const dialog = useRef<HTMLDialogElement>(null);
  const mounted = useRef(false);
  const [role, setRole] = useState<AgentAccessRole>(request.requested_role);
  const [duration, setDuration] = useState<GrantDuration>("none");
  const [workspacePath, setWorkspacePath] = useState("");
  const [commands, setCommands] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const pathValid = isValidWorkspacePath(workspacePath);
  const commandCount = parseAllowedCommands(commands).length;

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
      await teamAccessApi.approve(
        spaceId,
        request.id,
        buildApproveInput({ role, duration, workspacePath, commands }),
      );
      if (mounted.current) await onApproved();
    } catch (cause) {
      if (mounted.current) setError(cause);
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  const durationLabel = (value: GrantDuration) =>
    ({
      none: t("不限", "No expiry"),
      "1d": t("1 天", "1 day"),
      "7d": t("7 天", "7 days"),
      "30d": t("30 天", "30 days"),
    })[value];
  return (
    <dialog ref={dialog} onCancel={onClose} aria-labelledby="approve-request-title" className={teamDialogClass}>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 id="approve-request-title" className="text-lg font-semibold">
              {t("批准权限申请", "Approve access request")}
            </h2>
            <p className="mt-1 break-words text-sm text-text-secondary">
              {request.requester_name || "—"} → {agentName}
            </p>
          </div>
          <button type="button" className="rounded-lg p-2 hover:bg-glass-bg" aria-label={t("关闭", "Close")} onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        <fieldset className="space-y-2" disabled={busy}>
          <legend className="mb-2 text-sm">{t("给对方的权限", "Access to give")}</legend>
          {(["consultant", "collaborator"] as AgentAccessRole[]).map((value) => {
            const info = roleBadge(value, zh);
            return (
              <label
                key={value}
                className={`flex cursor-pointer items-start gap-3 rounded-xl border px-3 py-2.5 ${
                  role === value ? "border-neon-cyan/40 bg-neon-cyan/5" : "border-glass-border"
                }`}
              >
                <input
                  type="radio"
                  name="approve-role"
                  value={value}
                  checked={role === value}
                  onChange={() => setRole(value)}
                  className="mt-1 accent-neon-cyan"
                />
                <span className="min-w-0">
                  <span className="block text-sm font-medium">{info.label}</span>
                  <span className="block text-xs leading-5 text-text-secondary">{info.explanation}</span>
                </span>
              </label>
            );
          })}
        </fieldset>
        <label className="block space-y-1.5 text-sm">
          <span>{t("有效期", "Duration")}</span>
          <select className={field} value={duration} disabled={busy} onChange={(e) => setDuration(e.target.value as GrantDuration)}>
            {GRANT_DURATIONS.map((value) => (
              <option key={value} value={value}>
                {durationLabel(value)}
              </option>
            ))}
          </select>
        </label>
        {role === "collaborator" && (
          <>
            <label className="block space-y-1.5 text-sm">
              <span>{t("项目仓库路径（可选）", "Repository path (optional)")}</span>
              <input
                className={field}
                value={workspacePath}
                onChange={(e) => setWorkspacePath(e.target.value)}
                maxLength={1024}
                placeholder="~/projects/my-repo"
                disabled={busy}
                aria-invalid={!pathValid}
              />
              <span className={`block text-xs ${pathValid ? "text-text-secondary" : "text-red-500"}`}>
                {pathValid
                  ? t(
                      "你机器上的 git 仓库，绝对路径或 ~/ 开头；留空则使用临时目录。",
                      "A git repository on your machine (absolute or ~/). Leave empty for a temporary directory.",
                    )
                  : t("路径必须以 / 或 ~/ 开头。", "The path must start with / or ~/.")}
              </span>
            </label>
            <label className="block space-y-1.5 text-sm">
              <span>{t("允许执行的命令（可选）", "Allowed commands (optional)")}</span>
              <textarea
                className={`${field} min-h-[76px] resize-y`}
                value={commands}
                onChange={(e) => setCommands(e.target.value)}
                placeholder={"npm test\nnpm run lint"}
                disabled={busy}
                aria-invalid={commandCount > MAX_ALLOWED_COMMANDS}
              />
              <span className={`block text-xs ${commandCount > MAX_ALLOWED_COMMANDS ? "text-red-500" : "text-text-secondary"}`}>
                {t(
                  `逗号或换行分隔，最多 ${MAX_ALLOWED_COMMANDS} 条（当前 ${commandCount}）。`,
                  `Separate with commas or new lines, up to ${MAX_ALLOWED_COMMANDS} (${commandCount} now).`,
                )}
              </span>
            </label>
          </>
        )}
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
            disabled={busy || !pathValid || commandCount > MAX_ALLOWED_COMMANDS}
          >
            {busy && <Loader2 size={16} className="animate-spin" />}
            {t("批准", "Approve")}
          </button>
        </div>
      </form>
    </dialog>
  );
}
