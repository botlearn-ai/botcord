"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronRight, Loader2, Plus, X } from "lucide-react";
import { useLanguage } from "@/lib/i18n";
import { spaceError, teamSpacesApi } from "@/lib/team-spaces";
import type { UserAgent } from "@/lib/types";
import { AgentAvatar } from "./AgentIdentity";
import { teamDialogClass } from "./AccessRequestDialog";

/**
 * Add an Agent to the organization: pick one of my Agents (managers add it
 * directly, members submit it for approval) or create a new one.
 */
export default function AddAgentDialog({
  spaceId,
  agents,
  direct,
  onClose,
  onCreateNew,
  onAdded,
}: {
  spaceId: string;
  /** My Agents that are not yet in (or applying to) the organization. */
  agents: UserAgent[];
  /** Managers on a Hub with direct admission add without approval. */
  direct: boolean;
  onClose: () => void;
  onCreateNew: () => void;
  onAdded: (message: string) => void;
}) {
  const zh = useLanguage() === "zh";
  const t = (cn: string, en: string) => (zh ? cn : en);
  const dialog = useRef<HTMLDialogElement>(null);
  const mounted = useRef(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    mounted.current = true;
    dialog.current?.showModal?.();
    return () => {
      mounted.current = false;
    };
  }, []);

  async function add(agent: UserAgent) {
    if (busy) return;
    setBusy(agent.agent_id);
    setError(null);
    try {
      if (direct) await teamSpacesApi.addOwnedAgent(spaceId, agent.agent_id);
      else await teamSpacesApi.requestAgent(spaceId, agent.agent_id);
      if (mounted.current)
        onAdded(
          direct
            ? t(`${agent.display_name} 已加入组织。`, `${agent.display_name} joined the organization.`)
            : t(
                `已提交 ${agent.display_name} 的加入申请，等待管理员批准。`,
                `Submitted ${agent.display_name} for approval by an administrator.`,
              ),
        );
    } catch (cause) {
      if (mounted.current) setError(cause);
    } finally {
      if (mounted.current) setBusy(null);
    }
  }

  return (
    <dialog ref={dialog} onCancel={onClose} aria-labelledby="add-agent-title" className={teamDialogClass}>
      <div className="space-y-5">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 id="add-agent-title" className="text-lg font-semibold">
              {t("添加 Agent", "Add Agent")}
            </h2>
            <p className="mt-1 text-sm text-text-secondary">
              {direct
                ? t("加入后所有权仍归你，你可以授权成员使用。", "You keep ownership and decide who may use it.")
                : t(
                    "提交后由组织管理员批准；所有权仍归你。",
                    "An administrator approves it; you keep ownership.",
                  )}
            </p>
          </div>
          <button type="button" className="rounded-lg p-2 hover:bg-glass-bg" aria-label={t("关闭", "Close")} onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        <section className="space-y-2" aria-labelledby="add-agent-pick">
          <h3 id="add-agent-pick" className="text-sm font-medium">
            {t("从我的 Agent 中选择", "Pick one of my Agents")}
          </h3>
          {agents.length === 0 ? (
            <p className="rounded-xl border border-dashed border-glass-border px-4 py-5 text-center text-sm text-text-secondary">
              {t("你的 Agent 都已在本组织里，或正在等待批准。", "All your Agents are already here or waiting for approval.")}
            </p>
          ) : (
            <ul className="max-h-[40dvh] space-y-1.5 overflow-y-auto">
              {agents.map((agent) => (
                <li key={agent.agent_id}>
                  <button
                    className="liquid-list-row flex w-full items-center gap-3 rounded-xl border border-glass-border px-3 py-2.5 text-left transition-colors hover:border-neon-cyan/40 hover:bg-neon-cyan/5 disabled:cursor-not-allowed disabled:opacity-50"
                    disabled={busy != null}
                    onClick={() => void add(agent)}
                    aria-label={
                      direct
                        ? t(`添加 ${agent.display_name}`, `Add ${agent.display_name}`)
                        : t(`申请加入：${agent.display_name}`, `Apply with ${agent.display_name}`)
                    }
                  >
                    <AgentAvatar
                      agentId={agent.agent_id}
                      avatarUrl={agent.avatar_url}
                      name={agent.display_name}
                      status={agent.ws_online ? "online" : "offline"}
                      size={36}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{agent.display_name}</span>
                      <span className="block text-xs text-text-secondary">
                        {agent.ws_online ? t("在线", "Online") : t("离线", "Offline")}
                      </span>
                    </span>
                    <span className="inline-flex shrink-0 items-center gap-1 text-xs text-neon-cyan">
                      {busy === agent.agent_id ? (
                        <Loader2 size={14} className="animate-spin" />
                      ) : direct ? (
                        t("添加", "Add")
                      ) : (
                        t("申请加入", "Apply")
                      )}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <button
          className="flex w-full items-center gap-3 rounded-xl border border-dashed border-glass-border px-3 py-3 text-left transition-colors hover:border-neon-cyan/40 hover:bg-neon-cyan/5 disabled:opacity-50"
          disabled={busy != null}
          onClick={onCreateNew}
        >
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-neon-cyan/10 text-neon-cyan">
            <Plus size={18} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium">{t("新建 Agent", "Create a new Agent")}</span>
            <span className="block text-xs text-text-secondary">
              {direct
                ? t("创建后直接加入本组织", "Joins this organization once created")
                : t("创建后提交加入申请", "Submitted for approval once created")}
            </span>
          </span>
          <ChevronRight size={16} className="shrink-0 text-text-secondary" />
        </button>

        {error != null && (
          <p role="alert" className="rounded-xl border border-red-500/30 p-3 text-sm text-red-500">
            {spaceError(error, zh)}
          </p>
        )}
      </div>
    </dialog>
  );
}
