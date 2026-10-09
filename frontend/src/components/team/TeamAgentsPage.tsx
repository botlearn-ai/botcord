"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Bot,
  ChevronRight,
  Clock,
  Inbox,
  KeyRound,
  Loader2,
  MessageCircle,
  Plus,
  RefreshCw,
  X,
} from "lucide-react";
import { useLanguage } from "@/lib/i18n";
import { admitNewAgent, canManage, spaceError, teamSpacesApi } from "@/lib/team-spaces";
import {
  AGENT_TABS,
  accessBadge,
  accessSummary,
  agentRowActions,
  agentTabCounts,
  filterAgents,
  latestRequestByAgent,
  ownerAgentSummary,
  pendingCountFor,
  roleBadge,
  teamAccessApi,
  type AccessRequest,
  type AgentTab,
  type DirectoryAgent,
} from "@/lib/team-access";
import { orgRoomsApi } from "@/lib/org-rooms";
import type { TeamSnapshot } from "@/store/team-space-store";
import { useConfirm } from "@/store/useConfirmStore";
import { useDashboardSessionStore } from "@/store/useDashboardSessionStore";
import { useAccessChanges, useLoadedToDecide, useTeamAccessStore } from "@/store/useTeamAccessStore";
import CreateAgentDialog from "@/components/dashboard/CreateAgentDialog";
import { teamButton } from "./TeamConversationDialog";
import AccessBadge from "./AccessBadge";
import AccessRequestDialog, { teamDialogClass } from "./AccessRequestDialog";
import AccessRequestsInbox from "./AccessRequestsInbox";
import AddAgentDialog from "./AddAgentDialog";
import AgentManageDrawer, { type ManageTab } from "./AgentManageDrawer";
import { AgentAvatar, AgentMeta } from "./AgentIdentity";

const small =
  "inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg border border-glass-border px-3 py-1.5 text-xs transition-colors hover:bg-neon-cyan/10 focus-visible:outline-2 focus-visible:outline-neon-cyan disabled:cursor-not-allowed disabled:opacity-50";
const accent = "border-neon-cyan/30 bg-neon-cyan/10 text-neon-cyan";

/**
 * Team "Agent" page: every organization Agent with what the viewer can do,
 * filter tabs, the owner's pending-request banner, adding Agents, and a
 * manage drawer for owned Agents.
 */
export default function TeamAgentsPage({
  snapshot,
  onOpenRoom,
  onChanged,
}: {
  snapshot: TeamSnapshot;
  onOpenRoom: (roomId: string) => Promise<void> | void;
  /** Organization membership changed (Agent added/removed): reload the workspace snapshot. */
  onChanged: () => void;
}) {
  const zh = useLanguage() === "zh";
  const t = (cn: string, en: string) => (zh ? cn : en);
  const { selected: space, user, members } = snapshot;
  const spaceId = space.id;
  const manager = canManage(space);
  const direct = manager && space.agent_direct_admission_available === true;
  const confirm = useConfirm();
  const mounted = useRef(false);
  const [agents, setAgents] = useState<DirectoryAgent[]>([]);
  const [latest, setLatest] = useState<Record<string, AccessRequest>>({});
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<{ error: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [tab, setTab] = useState<AgentTab>("all");
  const [requesting, setRequesting] = useState<DirectoryAgent | null>(null);
  const [managing, setManaging] = useState<{ id: string; tab: ManageTab } | null>(null);
  const [dialog, setDialog] = useState<"add" | "create" | "inbox" | null>(null);
  const [version, setVersion] = useState(0);
  const toDecide = useLoadedToDecide(spaceId);
  // Realtime: a request was filed, decided or cancelled — refetch rows.
  const changes = useAccessChanges(spaceId);
  const reload = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    setLoading(true);
    Promise.all([
      teamAccessApi.directory(spaceId, controller.signal),
      // Request history only feeds the "declined" hint; the page still renders without it.
      teamAccessApi.requests(spaceId, "all", controller.signal).catch(() => null),
    ])
      .then(([directory, requests]) => {
        if (!mounted.current) return;
        setAgents(directory.agents);
        setLatest(requests ? latestRequestByAgent(requests.mine) : {});
        setError(null);
        setLoaded(true);
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
    // `members` changes after an Agent joins or leaves the organization.
  }, [spaceId, version, changes, members]);

  const counts = useMemo(() => agentTabCounts(agents, toDecide), [agents, toDecide]);
  const visible = useMemo(() => filterAgents(agents, tab, toDecide), [agents, tab, toDecide]);
  // The "needs my action" tab disappears once everything is handled.
  useEffect(() => {
    if (tab === "action" && counts.action === 0) setTab("all");
  }, [tab, counts.action]);
  const requestsToDecide = toDecide?.length ?? 0;
  const myMembershipId = members.users.find((u) => u.user_id === user.id)?.id;
  const waiting = members.agents.filter(
    (a) => a.status === "invited" && (manager || a.sponsor_user_membership_id === myMembershipId),
  );
  const availableToAdd = user.agents.filter(
    (agent) =>
      !members.agents.some(
        (m) => m.agent_id === agent.agent_id && (m.status === "active" || m.status === "invited"),
      ),
  );
  const managed = managing ? agents.find((a) => a.agent_id === managing.id) ?? null : null;

  async function act(key: string, task: () => Promise<unknown>) {
    if (busy) return;
    setBusy(key);
    setNotice(null);
    try {
      await task();
    } catch (cause) {
      if (mounted.current) setNotice({ error: true, text: spaceError(cause, zh) });
    } finally {
      if (mounted.current) setBusy(null);
    }
  }
  const chat = (agentId: string) =>
    act(`open:${agentId}`, async () => {
      const { room_id } = await orgRoomsApi.openAgentDm(spaceId, agentId);
      await onOpenRoom(room_id);
    });
  const cancelRequest = (agent: DirectoryAgent) =>
    act(`cancel:${agent.agent_id}`, async () => {
      const ok = await confirm({
        title: `${t("取消申请", "Cancel request")}: ${agent.display_name}`,
        message: t("所有者将不再看到这条申请。", "The owner will no longer see this request."),
        confirmLabel: t("取消申请", "Cancel request"),
        cancelLabel: t("保留", "Keep"),
      });
      if (!ok || !agent.pending_request) return;
      await teamAccessApi.cancel(spaceId, agent.pending_request.id);
      reload();
    });
  const approveJoin = (agentId: string, name: string) =>
    act(`approve:${agentId}`, async () => {
      await teamSpacesApi.approveAgent(spaceId, agentId);
      if (!mounted.current) return;
      setNotice({ error: false, text: t(`${name} 已加入组织。`, `${name} joined the organization.`) });
      onChanged();
    });
  const dropJoin = (agentId: string, name: string, mine: boolean) =>
    act(`drop:${agentId}`, async () => {
      const ok = await confirm({
        title: mine
          ? `${t("撤销加入申请", "Cancel application")}: ${name}`
          : `${t("拒绝加入", "Decline")}: ${name}`,
        message: t("它不会加入本组织，之后可以重新申请。", "It won't join the organization. It can apply again later."),
        confirmLabel: mine ? t("撤销申请", "Cancel application") : t("拒绝", "Decline"),
        tone: "danger",
      });
      if (!ok) return;
      await teamSpacesApi.removeAgent(spaceId, agentId);
      if (mounted.current) onChanged();
    });

  const tabLabel: Record<AgentTab, string> = {
    all: t("全部", "All"),
    mine: t("我的", "Mine"),
    available: t("我可用", "Available to me"),
    action: t("需要我处理", "Needs my action"),
  };
  const emptyState: Record<AgentTab, { title: string; hint: string }> = {
    all: {
      title: t("组织里还没有 Agent", "No Agents in this organization yet"),
      hint: t("添加你的 Agent，成员就能在房间里 @ 它或私聊它。", "Add one of your Agents so teammates can @mention or message it."),
    },
    mine: {
      title: t("你还没有 Agent 加入本组织", "None of your Agents has joined yet"),
      hint: t("添加后你可以决定谁能用它、它在哪些房间回复。", "Once added, you decide who may use it and where it replies."),
    },
    available: {
      title: t("还没有人把 Agent 共享给你", "No one has shared an Agent with you yet"),
      hint: t("在「全部」里找到想用的 Agent，向所有者申请权限。", "Find an Agent under All and ask its owner for access."),
    },
    action: {
      title: t("没有需要你处理的事", "Nothing needs your action"),
      hint: t("有人申请使用你的 Agent 时会出现在这里。", "Requests to use your Agents show up here."),
    },
  };

  const row = (agent: DirectoryAgent) => {
    const owner = agent.my_access === "owner";
    const pending = pendingCountFor(agent, toDecide);
    const last = latest[agent.agent_id];
    const declined =
      !agent.pending_request && last?.status === "rejected" && (agent.my_access === "none" || agent.my_access === "consultant");
    const actions = agentRowActions(agent);
    const openDrawer = (target: ManageTab = "overview") => setManaging({ id: agent.agent_id, tab: target });
    return (
      <li
        key={agent.agent_id}
        className="liquid-card flex flex-col gap-3 rounded-2xl border border-glass-border p-4 lg:flex-row lg:items-center"
      >
        <button
          className="flex min-w-0 flex-1 items-start gap-3 rounded-xl text-left focus-visible:outline-2 focus-visible:outline-neon-cyan"
          onClick={() => openDrawer()}
          aria-label={t(`查看 ${agent.display_name}`, `View ${agent.display_name}`)}
        >
          <AgentAvatar
            agentId={agent.agent_id}
            avatarUrl={agent.avatar_url}
            name={agent.display_name}
            status={agent.status}
            size={44}
          />
          <span className="min-w-0 flex-1 space-y-1">
            <span className="block truncate text-sm font-semibold">{agent.display_name}</span>
            <AgentMeta agent={agent} />
          </span>
        </button>
        <div className="min-w-0 space-y-1 pl-14 text-xs text-text-secondary lg:w-60 lg:shrink-0 lg:pl-0 xl:w-72">
          {owner ? (
            <p className="flex flex-wrap items-center gap-2">
              <span>{ownerAgentSummary(agent, zh)}</span>
              {pending > 0 && (
                <button
                  className="rounded-full bg-neon-cyan/15 px-2 py-0.5 text-[11px] font-medium text-neon-cyan hover:bg-neon-cyan/25"
                  onClick={() => openDrawer("access")}
                >
                  {t(`${pending} 个待处理`, `${pending} pending`)}
                </button>
              )}
            </p>
          ) : (
            <div className="flex items-start gap-2">
              <AccessBadge info={accessBadge(agent.my_access, zh)} className="shrink-0" />
              <span className="min-w-0 pt-0.5 leading-4">{accessSummary(agent.my_access, zh)}</span>
            </div>
          )}
          {agent.pending_request && (
            <p className="flex items-center gap-1">
              <Clock size={12} />
              {t("申请中", "Requested")}: {roleBadge(agent.pending_request.requested_role, zh).label}
            </p>
          )}
          {declined && (
            <p className="text-red-500">
              {t("上次申请被拒绝，可以重新申请。", "Your last request was declined. You can ask again.")}
            </p>
          )}
        </div>
        <div className="flex flex-wrap justify-end gap-2 lg:w-60 lg:shrink-0">
          {actions.map((action) => {
            const key = `${action}:${agent.agent_id}`;
            switch (action) {
              case "chat":
                return (
                  <button
                    key={action}
                    className={`${small} ${accent} flex-1 lg:flex-none`}
                    disabled={busy != null}
                    onClick={() => void chat(agent.agent_id)}
                    aria-label={t(`与 ${agent.display_name} 对话`, `Chat with ${agent.display_name}`)}
                  >
                    {busy === `open:${agent.agent_id}` ? <Loader2 size={13} className="animate-spin" /> : <MessageCircle size={13} />}
                    {t("对话", "Chat")}
                  </button>
                );
              case "manage":
                return (
                  <button key={action} className={`${small} flex-1 lg:flex-none`} onClick={() => openDrawer()}>
                    {t("管理", "Manage")}
                    <ChevronRight size={13} />
                  </button>
                );
              case "cancel":
                return (
                  <button
                    key={action}
                    className={`${small} flex-1 lg:flex-none`}
                    disabled={busy != null}
                    onClick={() => void cancelRequest(agent)}
                    aria-label={t(`取消对 ${agent.display_name} 的申请`, `Cancel request for ${agent.display_name}`)}
                  >
                    {busy === key && <Loader2 size={13} className="animate-spin" />}
                    {t("申请中 · 取消", "Requested · Cancel")}
                  </button>
                );
              default:
                return (
                  <button
                    key={action}
                    className={`${small} flex-1 lg:flex-none`}
                    disabled={busy != null}
                    onClick={() => setRequesting(agent)}
                  >
                    <KeyRound size={13} />
                    {action === "upgrade" ? t("申请协作", "Request collaborate") : t("申请权限", "Request access")}
                  </button>
                );
            }
          })}
        </div>
      </li>
    );
  };

  return (
    <section className="mx-auto w-full max-w-5xl space-y-5 px-4 pb-8 pt-5 sm:px-6 sm:pt-6" aria-labelledby="team-agents-title">
      <header className="grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-1">
        <h1 id="team-agents-title" className="text-xl font-semibold">
          Agent
        </h1>
        <div className="row-span-2 flex shrink-0 gap-2 max-sm:row-span-1">
          <button
            className="rounded-xl p-2.5 text-text-secondary hover:bg-glass-bg disabled:opacity-50"
            disabled={loading}
            onClick={reload}
            aria-label={t("刷新 Agent 列表", "Refresh Agents")}
          >
            <RefreshCw size={16} className={loading && loaded ? "animate-spin" : ""} />
          </button>
          <button className={`${teamButton} ${accent} font-medium`} onClick={() => setDialog("add")}>
            <Plus size={16} />
            {t("添加 Agent", "Add Agent")}
          </button>
        </div>
        <p className="text-sm text-text-secondary max-sm:col-span-2">
          {t("组织里的 Agent，以及你能用它们做什么。", "Agents in this organization and what you can do with them.")}
        </p>
      </header>

      {requestsToDecide > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-neon-cyan/30 bg-neon-cyan/5 px-4 py-3" role="status">
          <Inbox size={18} className="shrink-0 text-neon-cyan" />
          <p className="min-w-0 flex-1 text-sm">
            {t(
              `${requestsToDecide} 个权限申请待处理`,
              `${requestsToDecide} access request${requestsToDecide > 1 ? "s" : ""} need${requestsToDecide > 1 ? "" : "s"} your action`,
            )}
          </p>
          <button className={`${small} ${accent}`} onClick={() => setDialog("inbox")}>
            {t("处理", "Review")}
          </button>
        </div>
      )}

      {waiting.length > 0 && (
        <div className="space-y-2 rounded-2xl border border-glass-border p-4" aria-label={t("等待加入组织", "Waiting to join")}>
          <h2 className="text-sm font-medium">
            {t("等待加入组织", "Waiting to join")} · {waiting.length}
          </h2>
          <ul className="divide-y divide-glass-border">
            {waiting.map((agent) => {
              const mine = agent.sponsor_user_membership_id === myMembershipId;
              const sponsor = members.users.find((u) => u.id === agent.sponsor_user_membership_id);
              return (
                <li key={agent.id} className="flex flex-wrap items-center gap-3 py-2.5">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">{agent.display_name}</span>
                    <span className="block text-xs text-text-secondary">
                      {mine ? t("你的申请，等待管理员批准", "Your application, waiting for an administrator") : `${t("所有者", "Owner")}: ${sponsor?.display_name ?? "—"}`}
                    </span>
                  </span>
                  <span className="flex gap-2">
                    <button
                      className={`${small} ${mine ? "" : "text-red-500"}`}
                      disabled={busy != null}
                      onClick={() => void dropJoin(agent.agent_id, agent.display_name, mine)}
                    >
                      {busy === `drop:${agent.agent_id}` && <Loader2 size={13} className="animate-spin" />}
                      {mine ? t("撤销申请", "Cancel application") : t("拒绝", "Decline")}
                    </button>
                    {manager && (
                      <button
                        className={`${small} ${accent}`}
                        disabled={busy != null}
                        onClick={() => void approveJoin(agent.agent_id, agent.display_name)}
                      >
                        {busy === `approve:${agent.agent_id}` && <Loader2 size={13} className="animate-spin" />}
                        {t("批准加入", "Approve")}
                      </button>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <nav className="-mx-1 flex gap-1 overflow-x-auto px-1 [scrollbar-width:none]" aria-label={t("筛选 Agent", "Filter Agents")}>
        {AGENT_TABS.filter((id) => id !== "action" || counts.action > 0).map((id) => (
          <button
            key={id}
            aria-pressed={tab === id}
            onClick={() => setTab(id)}
            className={`inline-flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm ${
              tab === id ? "bg-neon-cyan/10 font-medium text-neon-cyan" : "text-text-secondary hover:bg-glass-bg hover:text-text-primary"
            }`}
          >
            {tabLabel[id]}
            <span
              className={`rounded-full px-1.5 text-[11px] tabular-nums ${
                id === "action" ? "bg-neon-cyan/15 text-neon-cyan" : "bg-glass-bg"
              }`}
            >
              {counts[id]}
            </span>
          </button>
        ))}
      </nav>

      {notice && (
        <p
          role={notice.error ? "alert" : "status"}
          className={`rounded-xl border p-3 text-sm ${notice.error ? "border-red-500/30 text-red-500" : "border-neon-cyan/30 text-neon-cyan"}`}
        >
          {notice.text}
        </p>
      )}
      {error != null && (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-red-500/30 p-4 text-sm text-red-500">
          <span>{spaceError(error, zh)}</span>
          <button className={small} onClick={reload}>
            {t("重试", "Retry")}
          </button>
        </div>
      )}
      {!loaded ? (
        error == null && (
          <p role="status" className="flex items-center justify-center gap-2 py-12 text-sm text-text-secondary">
            <Loader2 size={16} className="animate-spin" />
            {t("正在加载 Agent…", "Loading Agents…")}
          </p>
        )
      ) : visible.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-glass-border px-6 py-12 text-center">
          <Bot size={28} className="mx-auto mb-3 text-text-secondary opacity-60" />
          <p className="text-sm font-medium">{emptyState[tab].title}</p>
          <p className="mx-auto mt-1 max-w-sm text-xs leading-5 text-text-secondary">{emptyState[tab].hint}</p>
          {(tab === "all" || tab === "mine") && (
            <button className={`${teamButton} ${accent} mt-4`} onClick={() => setDialog("add")}>
              <Plus size={16} />
              {t("添加 Agent", "Add Agent")}
            </button>
          )}
          {tab === "available" && counts.all > 0 && (
            <button className={`${teamButton} mt-4`} onClick={() => setTab("all")}>
              {t("查看全部 Agent", "See all Agents")}
            </button>
          )}
        </div>
      ) : (
        <ul className="space-y-2" aria-label={tabLabel[tab]}>
          {visible.map(row)}
        </ul>
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
      {dialog === "add" && (
        <AddAgentDialog
          spaceId={spaceId}
          agents={availableToAdd}
          direct={direct}
          onClose={() => setDialog(null)}
          onCreateNew={() => setDialog("create")}
          onAdded={(text) => {
            setDialog(null);
            setNotice({ error: false, text });
            onChanged();
          }}
        />
      )}
      {dialog === "create" && (
        <CreateAgentDialog
          onClose={() => setDialog(null)}
          onSuccess={async (newAgentId) => {
            setDialog(null);
            // Keep the global owned-Agent list in sync, as the sidebar entry does.
            await useDashboardSessionStore.getState().refreshUserProfile().catch(() => undefined);
            // Admission runs after the dialog closes so failures surface on this page.
            void act(`create:${newAgentId}`, async () => {
              await admitNewAgent(spaceId, newAgentId, direct);
              if (!mounted.current) return;
              setNotice({
                error: false,
                text: direct
                  ? t("Agent 已创建并加入组织。", "Agent created and added to the organization.")
                  : t("Agent 已创建，加入申请已提交，等待管理员批准。", "Agent created. Application submitted; waiting for administrator approval."),
              });
              onChanged();
            });
          }}
        />
      )}
      {dialog === "inbox" && (
        <InboxDialog
          spaceId={spaceId}
          agentNames={Object.fromEntries(agents.map((a) => [a.agent_id, a.display_name]))}
          onDecided={reload}
          onClose={() => setDialog(null)}
        />
      )}
      {managing && managed && (
        <AgentManageDrawer
          key={managed.agent_id}
          spaceId={spaceId}
          agent={managed}
          isOwner={managed.my_access === "owner"}
          canRemove={manager || managed.my_access === "owner"}
          pending={pendingCountFor(managed, toDecide)}
          users={members.users}
          userId={user.id}
          initialTab={managing.tab}
          chatBusy={busy === `open:${managed.agent_id}`}
          onChat={managed.my_access !== "none" ? () => void chat(managed.agent_id) : null}
          onChanged={reload}
          onRemoved={() => {
            setManaging(null);
            setNotice({
              error: false,
              text: t(`${managed.display_name} 已从组织移除。`, `${managed.display_name} was removed from the organization.`),
            });
            onChanged();
          }}
          onClose={() => setManaging(null)}
        />
      )}
    </section>
  );
}

/** All pending access requests on my Agents, opened from the banner. */
function InboxDialog({
  spaceId,
  agentNames,
  onDecided,
  onClose,
}: {
  spaceId: string;
  agentNames: Record<string, string>;
  onDecided: () => void;
  onClose: () => void;
}) {
  const zh = useLanguage() === "zh";
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal?.();
  }, []);
  return (
    <dialog ref={dialog} onCancel={onClose} aria-label={zh ? "权限申请" : "Access requests"} className={teamDialogClass}>
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">{zh ? "权限申请" : "Access requests"}</h2>
        <button type="button" className="rounded-lg p-2 hover:bg-glass-bg" aria-label={zh ? "关闭" : "Close"} onClick={onClose}>
          <X size={18} />
        </button>
      </div>
      <AccessRequestsInbox spaceId={spaceId} agentNames={agentNames} onDecided={onDecided} />
    </dialog>
  );
}
