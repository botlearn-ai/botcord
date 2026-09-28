"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, UserPlus } from "lucide-react";
import { useLanguage } from "@/lib/i18n";
import {
  spaceError,
  teamSpacesApi,
  type AgentAccessGrant,
  type AgentAccessRole,
  type SpaceUser,
} from "@/lib/team-spaces";
import {
  GRANT_DURATIONS,
  MAX_ALLOWED_COMMANDS,
  buildGrantInput,
  grantExpiryLabel,
  grantRoleLabel,
  isValidWorkspacePath,
  parseAllowedCommands,
  type GrantDuration,
} from "@/lib/agent-access";
import { useConfirm } from "@/store/useConfirmStore";

const input =
  "w-full rounded-xl border border-glass-border bg-deep-black px-3 py-2.5 text-sm text-text-primary outline-none focus:border-neon-cyan focus:ring-2 focus:ring-neon-cyan/20 disabled:opacity-50";
const button =
  "inline-flex items-center justify-center gap-2 rounded-xl border border-glass-border px-4 py-2.5 text-sm font-medium transition-colors hover:bg-neon-cyan/10 focus-visible:outline-2 focus-visible:outline-neon-cyan disabled:cursor-not-allowed disabled:opacity-50";
const primary = `${button} border-neon-cyan/30 bg-neon-cyan/10 text-neon-cyan`;

/** Owner-side panel: grant organization members access to one of your Agents. */
export default function AgentAccessGrants({
  spaceId,
  agentId,
  agentName,
  users,
  userId,
}: {
  spaceId: string;
  agentId: string;
  agentName: string;
  users: SpaceUser[];
  userId: string;
}) {
  const zh = useLanguage() === "zh";
  const t = (cn: string, en: string) => (zh ? cn : en);
  const confirm = useConfirm();
  const mounted = useRef(false);
  const locked = useRef(false);
  const [grants, setGrants] = useState<AgentAccessGrant[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ error: boolean; text: string } | null>(null);
  const [grantee, setGrantee] = useState("");
  const [role, setRole] = useState<AgentAccessRole>("consultant");
  const [duration, setDuration] = useState<GrantDuration>("none");
  const [workspacePath, setWorkspacePath] = useState("");
  const [commands, setCommands] = useState("");
  const candidates = users.filter((u) => u.status === "active" && u.user_id !== userId);
  const commandCount = parseAllowedCommands(commands).length;
  const pathValid = isValidWorkspacePath(workspacePath);

  const reload = useCallback(async (signal?: AbortSignal) => {
    try {
      const { grants: next } = await teamSpacesApi.accessGrants(spaceId, agentId, signal);
      if (mounted.current) setGrants(next.filter((g) => !g.revoked_at));
    } catch (cause) {
      if (mounted.current && !signal?.aborted)
        setNotice({ error: true, text: spaceError(cause, zh) });
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [spaceId, agentId, zh]);
  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    void reload(controller.signal);
    return () => {
      mounted.current = false;
      controller.abort();
    };
  }, [reload]);

  async function run(task: () => Promise<boolean | void>, success: string) {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setNotice(null);
    try {
      if ((await task()) === false) return;
      if (!mounted.current) return;
      setNotice({ error: false, text: success });
      await reload();
    } catch (cause) {
      if (mounted.current) setNotice({ error: true, text: spaceError(cause, zh) });
    } finally {
      locked.current = false;
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
  const nameOf = (grant: AgentAccessGrant) =>
    grant.grantee_name ??
    users.find((u) => u.user_id === grant.grantee_user_id)?.display_name ??
    grant.grantee_human_id ??
    "—";

  return (
    <div className="w-full space-y-4 rounded-xl border border-glass-border bg-deep-black/40 p-4">
      <p className="text-xs leading-5 text-text-secondary">
        {t(
          "授权后，对方可在私信中直接与该 Agent 对话。咨询者只能提问和读代码；协作者可在独立副本中修改代码，改动会提交到 guest/<授权> 分支，由你审核后合并。",
          "Grantees can talk to this Agent in a direct message. Consultants can only ask and read code; collaborators may edit code in an isolated copy, with changes committed to a guest/<grant> branch for you to review.",
        )}
      </p>
      {notice && (
        <p
          role={notice.error ? "alert" : "status"}
          className={`text-sm ${notice.error ? "text-red-500" : "text-neon-cyan"}`}
        >
          {notice.text}
        </p>
      )}
      <form
        className="space-y-3"
        aria-label={`${t("授权成员使用", "Grant access")}: ${agentName}`}
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            await teamSpacesApi.grantAccess(
              spaceId,
              agentId,
              buildGrantInput({ userId: grantee, role, duration, workspacePath, commands }),
            );
            setGrantee("");
            setWorkspacePath("");
            setCommands("");
          }, t("授权已创建。", "Access granted."));
        }}
      >
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="space-y-1.5 text-sm">
            <span>{t("组织成员", "Member")}</span>
            <select
              className={input}
              value={grantee}
              onChange={(e) => setGrantee(e.target.value)}
              disabled={busy || !candidates.length}
              required
            >
              <option value="">
                {candidates.length
                  ? t("请选择成员", "Select a member")
                  : t("暂无其他成员", "No other members")}
              </option>
              {candidates.map((u) => (
                <option key={u.user_id} value={u.user_id}>
                  {u.display_name}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1.5 text-sm">
            <span>{t("角色", "Role")}</span>
            <select
              className={input}
              value={role}
              onChange={(e) => setRole(e.target.value as AgentAccessRole)}
              disabled={busy}
            >
              <option value="consultant">
                {t("咨询者（只读：提问、读代码）", "Consultant (read-only: ask, read code)")}
              </option>
              <option value="collaborator">
                {t("协作者（可在独立副本改代码）", "Collaborator (edits in an isolated copy)")}
              </option>
            </select>
          </label>
          <label className="space-y-1.5 text-sm">
            <span>{t("有效期", "Duration")}</span>
            <select
              className={input}
              value={duration}
              onChange={(e) => setDuration(e.target.value as GrantDuration)}
              disabled={busy}
            >
              {GRANT_DURATIONS.map((value) => (
                <option key={value} value={value}>
                  {durationLabel(value)}
                </option>
              ))}
            </select>
          </label>
        </div>
        {role === "collaborator" && (
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1.5 text-sm">
              <span>{t("项目仓库路径（可选）", "Repository path (optional)")}</span>
              <input
                className={input}
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
            <label className="space-y-1.5 text-sm">
              <span>{t("允许执行的命令（可选）", "Allowed commands (optional)")}</span>
              <textarea
                className={`${input} min-h-[76px] resize-y`}
                value={commands}
                onChange={(e) => setCommands(e.target.value)}
                placeholder={"npm test\nnpm run lint"}
                disabled={busy}
                aria-invalid={commandCount > MAX_ALLOWED_COMMANDS}
              />
              <span
                className={`block text-xs ${commandCount > MAX_ALLOWED_COMMANDS ? "text-red-500" : "text-text-secondary"}`}
              >
                {t(
                  `逗号或换行分隔，最多 ${MAX_ALLOWED_COMMANDS} 条（当前 ${commandCount}）。`,
                  `Separate with commas or new lines, up to ${MAX_ALLOWED_COMMANDS} (${commandCount} now).`,
                )}
              </span>
            </label>
          </div>
        )}
        <button
          className={primary}
          disabled={busy || !grantee || !pathValid || commandCount > MAX_ALLOWED_COMMANDS}
        >
          {busy ? <Loader2 size={16} className="animate-spin" /> : <UserPlus size={16} />}
          {t("授权", "Grant access")}
        </button>
      </form>
      <div className="border-t border-glass-border pt-3">
        <h4 className="mb-2 text-sm font-medium">{t("已授权成员", "Members with access")}</h4>
        {loading ? (
          <p role="status" className="flex items-center gap-2 text-xs text-text-secondary">
            <Loader2 size={14} className="animate-spin" />
            {t("正在加载授权…", "Loading access…")}
          </p>
        ) : grants.length === 0 ? (
          <p className="text-xs text-text-secondary">
            {t("还没有授权任何成员。", "No one has access yet.")}
          </p>
        ) : (
          <ul className="divide-y divide-glass-border">
            {grants.map((grant) => (
              <li key={grant.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="break-words font-medium">{nameOf(grant)}</span>
                    <span className="rounded-md bg-neon-cyan/10 px-1.5 py-0.5 text-[11px] text-neon-cyan">
                      {grantRoleLabel(grant.role, zh)}
                    </span>
                  </p>
                  <p className="mt-1 break-all text-xs text-text-secondary">
                    {grantExpiryLabel(grant, zh)}
                    {grant.role === "collaborator" && grant.workspace_path
                      ? ` · ${grant.workspace_path}`
                      : ""}
                    {grant.allowed_commands.length
                      ? ` · ${grant.allowed_commands.join(", ")}`
                      : ""}
                  </p>
                </div>
                <button
                  className={`${button} text-red-500`}
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      const accepted = await confirm({
                        title: `${t("撤销授权", "Revoke access")}: ${nameOf(grant)}`,
                        message: t(
                          `对方将无法继续与 ${agentName} 对话，历史消息保留。`,
                          `They will no longer be able to talk to ${agentName}. Message history is kept.`,
                        ),
                        confirmLabel: t("撤销", "Revoke"),
                        tone: "danger",
                      });
                      if (!accepted || !mounted.current) return false;
                      await teamSpacesApi.revokeAccess(spaceId, grant.id);
                    }, t("授权已撤销。", "Access revoked."))
                  }
                >
                  {t("撤销", "Revoke")}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
