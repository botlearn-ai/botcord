"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Bot, Clock, KeyRound, Loader2, MessageCircle, RefreshCw } from "lucide-react";
import { useLanguage } from "@/lib/i18n";
import { spaceError } from "@/lib/team-spaces";
import {
  accessBadge,
  canChatWith,
  canRequestAccess,
  latestRequestByAgent,
  roleBadge,
  teamAccessApi,
  type AccessRequest,
  type DirectoryAgent,
} from "@/lib/team-access";
import { orgRoomsApi } from "@/lib/org-rooms";
import { useConfirm } from "@/store/useConfirmStore";
import { useToDecide, useTeamAccessStore } from "@/store/useTeamAccessStore";
import { teamButton } from "./TeamConversationDialog";
import AccessBadge from "./AccessBadge";
import AccessRequestDialog from "./AccessRequestDialog";

const small =
  "inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg border border-glass-border px-3 py-1.5 text-xs transition-colors hover:bg-neon-cyan/10 focus-visible:outline-2 focus-visible:outline-neon-cyan disabled:cursor-not-allowed disabled:opacity-50";

/**
 * Organization Agent directory: every active Agent in the organization with
 * what the viewer may do with it. Usable Agents open an organization DM;
 * the rest can be requested from their owner.
 */
export default function SharedAgentsPanel({
  spaceId,
  agentsHref,
  onOpenRoom,
}: {
  spaceId: string;
  /** Where owners decide pending requests (the Agent section). */
  agentsHref?: string;
  onOpenRoom: (roomId: string) => Promise<void> | void;
}) {
  const zh = useLanguage() === "zh";
  const t = (cn: string, en: string) => (zh ? cn : en);
  const confirm = useConfirm();
  const mounted = useRef(false);
  const [agents, setAgents] = useState<DirectoryAgent[]>([]);
  const [latest, setLatest] = useState<Record<string, AccessRequest>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [requesting, setRequesting] = useState<DirectoryAgent | null>(null);
  const [version, setVersion] = useState(0);
  const toDecide = useToDecide(spaceId);
  const reload = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    setLoading(true);
    Promise.all([
      teamAccessApi.directory(spaceId, controller.signal),
      // Request history is only for status hints; the directory still renders without it.
      teamAccessApi.requests(spaceId, "all", controller.signal).catch(() => null),
    ])
      .then(([directory, requests]) => {
        if (!mounted.current) return;
        setAgents(directory.agents);
        setLatest(requests ? latestRequestByAgent(requests.mine) : {});
        setError(null);
      })
      .catch((cause) => {
        if (mounted.current && !controller.signal.aborted) setError(cause);
      })
      .finally(() => {
        if (mounted.current && !controller.signal.aborted) setLoading(false);
      });
    void useTeamAccessStore.getState().refreshToDecide(spaceId);
    return () => {
      mounted.current = false;
      controller.abort();
    };
  }, [spaceId, version]);

  async function act(key: string, task: () => Promise<unknown>, after?: () => void) {
    if (busy) return;
    setBusy(key);
    setError(null);
    try {
      await task();
      after?.();
    } catch (cause) {
      if (mounted.current) setError(cause);
    } finally {
      if (mounted.current) setBusy(null);
    }
  }
  const open = (agentId: string) =>
    act(`open:${agentId}`, async () => {
      const { room_id } = await orgRoomsApi.openAgentDm(spaceId, agentId);
      await onOpenRoom(room_id);
    });
  const cancel = (agent: DirectoryAgent) =>
    act(
      `cancel:${agent.agent_id}`,
      async () => {
        const ok = await confirm({
          title: `${t("取消申请", "Cancel request")}: ${agent.display_name}`,
          message: t("所有者将不再看到这条申请。", "The owner will no longer see this request."),
          confirmLabel: t("取消申请", "Cancel request"),
          cancelLabel: t("保留", "Keep"),
        });
        if (!ok || !agent.pending_request) return;
        await teamAccessApi.cancel(spaceId, agent.pending_request.id);
      },
      reload,
    );

  const groups: { key: string; title: string; empty: string; items: DirectoryAgent[] }[] = [
    {
      key: "mine",
      title: t("我的 Agent", "My Agents"),
      empty: t("你还没有 Agent 加入本组织。", "None of your Agents has joined this organization yet."),
      items: agents.filter((a) => a.my_access === "owner"),
    },
    {
      key: "usable",
      title: t("共享给我的", "Shared with me"),
      empty: t("还没有成员授权 Agent 给你。", "No one has shared an Agent with you yet."),
      items: agents.filter((a) => a.my_access === "collaborator" || a.my_access === "consultant"),
    },
    {
      key: "others",
      title: t("组织里的其他 Agent", "Other Agents in this organization"),
      empty: t("组织里没有其他 Agent。", "There are no other Agents in this organization."),
      items: agents.filter((a) => a.my_access === "none"),
    },
  ];

  const row = (agent: DirectoryAgent) => {
    const pending = agent.pending_request;
    const last = latest[agent.agent_id];
    const rejected = !pending && last?.status === "rejected" && canRequestAccess(agent);
    const incoming = toDecide.filter((r) => r.agent_id === agent.agent_id).length;
    return (
      <li
        key={agent.agent_id}
        className="flex flex-wrap items-center gap-3 rounded-2xl border border-glass-border bg-glass-bg p-4"
      >
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-glass-border bg-deep-black text-neon-cyan">
          <Bot size={19} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-2">
            <span className="break-words text-sm font-medium">{agent.display_name}</span>
            <AccessBadge info={accessBadge(agent.my_access, zh)} />
          </p>
          <p className="mt-1 break-words text-xs text-text-secondary">
            {agent.my_access === "owner"
              ? t("我拥有", "Owned by you")
              : `${t("所有者", "Owner")}: ${agent.owner_name || "—"}`}
          </p>
          {pending && (
            <p className="mt-1 flex flex-wrap items-center gap-1 text-xs text-text-secondary">
              <Clock size={12} />
              {t("申请中", "Pending")}: {roleBadge(pending.requested_role, zh).label}
            </p>
          )}
          {rejected && (
            <p className="mt-1 text-xs text-red-500">
              {t("上次申请被拒绝，可以重新申请。", "Your last request was declined. You can ask again.")}
            </p>
          )}
          {incoming > 0 && agentsHref && (
            <Link href={agentsHref} className="mt-1 inline-block text-xs text-neon-cyan underline-offset-2 hover:underline">
              {t(`${incoming} 个权限申请待处理`, `${incoming} access request${incoming > 1 ? "s" : ""} to review`)}
            </Link>
          )}
        </div>
        <div className="flex w-full flex-wrap justify-end gap-2 sm:w-auto">
          {pending ? (
            <button className={small} disabled={busy != null} onClick={() => void cancel(agent)}>
              {busy === `cancel:${agent.agent_id}` && <Loader2 size={13} className="animate-spin" />}
              {t("取消申请", "Cancel request")}
            </button>
          ) : (
            canRequestAccess(agent) && (
              <button className={small} disabled={busy != null} onClick={() => setRequesting(agent)}>
                <KeyRound size={13} />
                {agent.my_access === "consultant"
                  ? t("申请协作权限", "Request collaborate")
                  : t("申请权限", "Request access")}
              </button>
            )
          )}
          {canChatWith(agent) && (
            <button
              className={`${small} border-neon-cyan/30 text-neon-cyan`}
              disabled={busy != null}
              onClick={() => void open(agent.agent_id)}
              aria-label={t(`与 ${agent.display_name} 对话`, `Chat with ${agent.display_name}`)}
            >
              {busy === `open:${agent.agent_id}` ? (
                <Loader2 size={13} className="animate-spin" />
              ) : (
                <MessageCircle size={13} />
              )}
              {t("对话", "Chat")}
            </button>
          )}
        </div>
      </li>
    );
  };

  return (
    <section className="mx-auto max-w-3xl space-y-4" aria-label={t("组织 Agent 目录", "Organization Agent directory")}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-xl text-sm leading-6 text-text-secondary">
          {t(
            "组织里的全部 Agent，以及你能用它们做什么。能用的 Agent 点「对话」在组织消息里打开私聊；没有权限的可以向所有者申请。",
            "Every Agent in this organization and what you can do with it. Use Chat to open a direct message in Team messages; ask the owner for access to the others.",
          )}
        </p>
        <button
          className={teamButton}
          disabled={loading}
          onClick={reload}
          aria-label={t("刷新 Agent 目录", "Refresh Agent directory")}
        >
          <RefreshCw size={16} />
        </button>
      </div>
      {error != null && (
        <p role="alert" className="rounded-xl border border-red-500/30 p-4 text-sm text-red-500">
          {spaceError(error, zh)}
        </p>
      )}
      {loading && !agents.length ? (
        <p role="status" className="flex items-center justify-center gap-2 py-8 text-xs text-text-secondary">
          <Loader2 size={16} className="animate-spin" />
          {t("正在加载…", "Loading…")}
        </p>
      ) : (
        groups.map((group) => (
          <div key={group.key} className="space-y-2">
            <h2 className="text-xs font-medium text-text-secondary">
              {group.title} · {group.items.length}
            </h2>
            {group.items.length === 0 ? (
              <p className="rounded-2xl border border-dashed border-glass-border px-4 py-6 text-center text-sm text-text-secondary">
                {group.empty}
              </p>
            ) : (
              <ul className="space-y-2" aria-label={group.title}>
                {group.items.map(row)}
              </ul>
            )}
          </div>
        ))
      )}
      {requesting && (
        <AccessRequestDialog
          spaceId={spaceId}
          agent={requesting}
          onClose={() => setRequesting(null)}
          onSubmitted={() => {
            setRequesting(null);
            reload();
          }}
        />
      )}
    </section>
  );
}
