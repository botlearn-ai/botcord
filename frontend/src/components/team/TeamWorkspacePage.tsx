"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { useStore } from "zustand";
import {
  Bot,
  Building2,
  Hash,
  Inbox,
  Loader2,
  LockKeyhole,
  MessageCircle,
  MessageSquare,
  Plus,
  RefreshCw,
  Search,
  Settings,
  Users,
} from "lucide-react";
import { useLanguage } from "@/lib/i18n";
import {
  createTeamSpaceStore,
  type TeamSnapshot,
} from "@/store/team-space-store";
import { subscribeToPageReturn } from "@/lib/page-return";
import { canManage, spaceError } from "@/lib/team-spaces";
import {
  conversationName,
  teamConversationsApi,
  type TeamConversation,
} from "@/lib/team-conversations";
import TeamSpacesPage from "./TeamSpacesPage";
import TeamWorkspaceSkeleton from "./TeamWorkspaceSkeleton";
import TeamConversationDialog, { teamButton } from "./TeamConversationDialog";
import TeamThread from "./TeamThread";

export type TeamView = "messages" | "rooms" | "members" | "agents" | "settings";
export function teamView(value: string | null): TeamView {
  return value === "rooms" ||
    value === "members" ||
    value === "agents" ||
    value === "settings"
    ? value
    : "messages";
}
export function teamHref(
  space: string,
  view: TeamView = "messages",
  conversation?: string
) {
  const params = new URLSearchParams({ space });
  if (view !== "messages") params.set("view", view);
  if (conversation) params.set("conversation", conversation);
  return `/chats/team?${params}`;
}

export default function TeamWorkspacePage() {
  const router = useRouter();
  const query = useSearchParams();
  const requestedId = query.get("space");
  const store = useMemo(() => createTeamSpaceStore(true), []);
  const { snapshot, loading, error, load, refresh } = useStore(store);
  const zh = useLanguage() === "zh";
  useEffect(() => {
    void load(requestedId);
    return () => store.getState().cancel();
  }, [load, requestedId, store]);
  useEffect(
    () => subscribeToPageReturn(() => void refresh(requestedId)),
    [refresh, requestedId]
  );
  const update = useCallback(() => {
    void load(requestedId, { background: true });
  }, [load, requestedId]);
  const current =
    snapshot && (!requestedId || snapshot.selected.id === requestedId)
      ? snapshot
      : null;
  useEffect(() => {
    if (!requestedId && current?.selected.kind === "organization") {
      router.replace(
        teamHref(
          current.selected.id,
          teamView(query.get("view")),
          query.get("conversation") ?? undefined
        )
      );
    }
  }, [
    current?.selected.id,
    current?.selected.kind,
    requestedId,
    router,
    query,
  ]);
  if (loading || (!current && !error)) return <TeamWorkspaceSkeleton />;
  if (error)
    return (
      <div role="alert" className="m-auto max-w-lg space-y-4 p-8 text-center">
        <p>{spaceError(error, zh)}</p>
        <button className={teamButton} onClick={() => void load(requestedId)}>
          {zh ? "重试" : "Retry"}
        </button>
        <Link className={`${teamButton} ml-3`} href="/chats/team">
          {zh ? "返回我的组织" : "My organizations"}
        </Link>
      </div>
    );
  if (
    !current ||
    current.selected.kind !== "organization" ||
    current.selected.status !== "active" ||
    current.selected.membership.status !== "active"
  ) {
    return (
      <div className="h-full overflow-y-auto p-4 sm:p-8">
        <TeamSpacesPage teamMode onChanged={update} />
      </div>
    );
  }
  return (
    <TeamWorkspace
      key={current.selected.id}
      snapshot={current}
      onMembershipChanged={update}
    />
  );
}

export function TeamWorkspace({
  snapshot,
  onMembershipChanged,
}: {
  snapshot: TeamSnapshot;
  onMembershipChanged: () => void;
}) {
  const zh = useLanguage() === "zh";
  const t = (cn: string, en: string) => (zh ? cn : en);
  const router = useRouter();
  const query = useSearchParams();
  const view = teamView(query.get("view"));
  const selectedId = query.get("conversation");
  const { selected: space, user, members } = snapshot;
  const [conversations, setConversations] = useState<TeamConversation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [search, setSearch] = useState("");
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [dialog, setDialog] = useState<"room" | "dm" | null>(null);
  const mounted = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const pending = useRef<Promise<void> | null>(null);
  const messaging = space.organization_messaging_available === true;
  const reload = useCallback(
    (force = false) => {
      if (pending.current && !force) return pending.current;
      const version = ++generation.current;
      controller.current?.abort();
      controller.current = new AbortController();
      const task = (async () => {
        try {
          const response = await teamConversationsApi.list(
            space.id,
            controller.current!.signal
          );
          if (mounted.current && version === generation.current) {
            setConversations(response.conversations);
            setError(null);
          }
        } catch (cause) {
          if (mounted.current && version === generation.current) {
            setError(cause);
            setConversations([]);
          }
        } finally {
          if (mounted.current && version === generation.current)
            setLoading(false);
        }
      })();
      pending.current = task;
      void task.finally(() => {
        if (pending.current === task) pending.current = null;
      });
      return task;
    },
    [space.id]
  );
  useEffect(() => {
    mounted.current = true;
    if (messaging) void reload();
    else setLoading(false);
    const poll = () => {
      if (messaging && document.visibilityState === "visible") void reload();
    };
    const timer = setInterval(poll, 8000);
    document.addEventListener("visibilitychange", poll);
    return () => {
      mounted.current = false;
      generation.current++;
      pending.current = null;
      controller.current?.abort();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", poll);
    };
  }, [reload, messaging]);
  const title = (c: TeamConversation) =>
    conversationName(c, user.id, t("成员已离开", "Member has left"));
  const inbox = view === "messages" || view === "rooms";
  const current = conversations.find((c) => c.id === selectedId);
  const visible = conversations.filter(
    (c) =>
      (view !== "rooms" || c.kind === "room") &&
      (!unreadOnly || c.unread_count > 0) &&
      title(c).toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())
  );
  const unread = conversations.reduce((sum, c) => sum + c.unread_count, 0);
  const activeUsers = members.users.filter((m) => m.status === "active").length;
  const activeAgents = members.agents.filter(
    (m) => m.status === "active"
  ).length;
  const navigation = [
    {
      id: "messages" as const,
      label: t("消息", "Messages"),
      Icon: MessageSquare,
      count: unread || null,
    },
    {
      id: "rooms" as const,
      label: t("房间", "Rooms"),
      Icon: Hash,
      count: null,
    },
    {
      id: "members" as const,
      label: t("成员", "Members"),
      Icon: Users,
      count: activeUsers,
    },
    { id: "agents" as const, label: "Agent", Icon: Bot, count: activeAgents },
  ];
  return (
    <div
      className="flex h-full min-h-0 flex-col md:flex-row"
      data-team-workspace="true"
    >
      <aside className="flex shrink-0 flex-col border-b border-glass-border bg-glass-bg md:w-52 md:border-b-0 md:border-r xl:w-56">
        <div className="flex h-[76px] shrink-0 items-center gap-3 border-b border-glass-border px-4">
          <div className="rounded-xl bg-neon-cyan/10 p-2.5 text-neon-cyan">
            <Building2 size={22} />
          </div>
          <label className="min-w-0 flex-1">
            <span className="mb-1 block text-[11px] text-text-secondary">
              {t("当前组织", "Organization")}
            </span>
            <select
              aria-label={t("切换组织", "Switch organization")}
              value={space.id}
              className="w-full truncate bg-transparent text-sm font-semibold outline-none focus-visible:ring-2 focus-visible:ring-neon-cyan"
              onChange={(e) => router.push(teamHref(e.target.value))}
            >
              {snapshot.spaces
                .filter((s) => s.kind === "organization")
                .map((s) => (
                  <option key={s.id} value={s.id} className="bg-deep-black">
                    {s.name}
                    {s.membership.status === "invited"
                      ? t(" · 待接受", " · Invited")
                      : ""}
                  </option>
                ))}
            </select>
          </label>
        </div>
        <nav
          className="flex gap-1 overflow-x-auto p-2 md:flex-col md:p-3"
          aria-label={t("团队导航", "Team navigation")}
        >
          {navigation.map(({ id, label, Icon, count }) => (
            <Link
              key={id}
              href={teamHref(space.id, id)}
              aria-current={view === id ? "page" : undefined}
              className={`flex min-w-max items-center gap-1.5 rounded-xl px-2 py-3 text-sm md:gap-3 md:px-3 ${
                view === id
                  ? "bg-neon-cyan/10 font-medium text-neon-cyan"
                  : "text-text-secondary hover:bg-glass-bg hover:text-text-primary"
              }`}
            >
              <Icon size={18} />
              <span className="flex-1">{label}</span>
              {count != null && (
                <span className="hidden rounded-md bg-glass-bg px-1.5 text-[11px] tabular-nums md:inline">
                  {count > 99 ? "99+" : count}
                </span>
              )}
            </Link>
          ))}
          <Link
            href={teamHref(space.id, "settings")}
            aria-current={view === "settings" ? "page" : undefined}
            className={`flex items-center gap-1.5 rounded-xl px-2 py-3 text-sm md:mt-4 md:gap-3 md:px-3 ${
              view === "settings"
                ? "bg-neon-cyan/10 text-neon-cyan"
                : "text-text-secondary hover:bg-glass-bg"
            }`}
          >
            <Settings size={18} />
            <span className="whitespace-nowrap">{t("设置", "Settings")}</span>
          </Link>
        </nav>
        <div className="mt-auto hidden space-y-3 p-4 md:block">
          <Link
            className="flex items-center gap-2 text-xs text-text-secondary hover:text-neon-cyan"
            href={`/settings/spaces?space=${encodeURIComponent(space.id)}`}
          >
            <Plus size={14} />
            {t("创建或管理组织", "Manage organizations")}
          </Link>
          <div className="flex items-center gap-2 border-t border-glass-border pt-4">
            <span className="flex h-8 w-8 items-center justify-center rounded-full bg-neon-cyan/10 text-sm text-neon-cyan">
              {user.display_name.slice(0, 1)}
            </span>
            <div className="min-w-0">
              <p className="truncate text-xs font-medium">
                {user.display_name}
              </p>
              <p className="mt-0.5 text-[11px] text-text-secondary">
                {space.roles.includes("owner")
                  ? t("组织所有者", "Organization owner")
                  : canManage(space)
                  ? t("管理员", "Administrator")
                  : t("组织成员", "Organization member")}
              </p>
            </div>
          </div>
        </div>
      </aside>
      {inbox ? (
        <>
          <section
            className={`min-h-0 w-full shrink-0 flex-col border-r border-glass-border md:flex md:w-72 xl:w-80 ${
              selectedId ? "hidden" : "flex flex-1 md:flex-none"
            }`}
            aria-label={t("会话列表", "Conversations")}
          >
            <header className="flex h-[76px] shrink-0 items-center justify-between px-5">
              <h1 className="text-lg font-semibold">
                {view === "rooms" ? t("房间", "Rooms") : t("消息", "Messages")}
              </h1>
              <div className="flex gap-1">
                <button
                  className="rounded-lg p-2 text-text-secondary hover:bg-glass-bg"
                  aria-label={t("刷新消息", "Refresh conversations")}
                  disabled={loading || !messaging}
                  onClick={() => void reload()}
                >
                  <RefreshCw size={16} />
                </button>
                <button
                  className="rounded-lg bg-neon-cyan/10 p-2 text-neon-cyan disabled:opacity-40"
                  aria-label={
                    view === "rooms"
                      ? t("创建房间", "Create room")
                      : t("发起私聊", "New direct message")
                  }
                  disabled={!messaging}
                  onClick={() => setDialog(view === "rooms" ? "room" : "dm")}
                >
                  <Plus size={18} />
                </button>
              </div>
            </header>
            <div className="space-y-3 px-4 pb-4">
              <label className="flex items-center gap-2 rounded-xl border border-glass-border bg-glass-bg px-3 py-2">
                <Search size={15} className="shrink-0 text-text-secondary" />
                <input
                  className="min-w-0 flex-1 bg-transparent text-sm outline-none"
                  aria-label={t("搜索会话", "Search conversations")}
                  placeholder={t("搜索会话名称", "Search conversations")}
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </label>
              <div className="flex gap-2">
                {[false, true].map((only) => (
                  <button
                    key={String(only)}
                    className={`rounded-lg px-3 py-1.5 text-xs ${
                      unreadOnly === only
                        ? "bg-neon-cyan/10 text-neon-cyan"
                        : "text-text-secondary hover:bg-glass-bg"
                    }`}
                    aria-pressed={unreadOnly === only}
                    onClick={() => setUnreadOnly(only)}
                  >
                    {only ? t("未读", "Unread") : t("全部", "All")}
                  </button>
                ))}
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
              {loading && (
                <p
                  role="status"
                  className="flex items-center justify-center gap-2 py-8 text-xs text-text-secondary"
                >
                  <Loader2 size={16} className="animate-spin" />
                  {t("正在加载会话…", "Loading conversations…")}
                </p>
              )}
              {error != null && (
                <p role="alert" className="p-4 text-sm text-red-500">
                  {spaceError(error, zh)}
                </p>
              )}
              {!loading && !error && !visible.length && (
                <div className="px-4 py-10 text-center text-text-secondary">
                  <Inbox size={28} className="mx-auto mb-3 opacity-50" />
                  <p className="text-sm">
                    {search
                      ? t("没有匹配的会话", "No matching conversations")
                      : unreadOnly
                      ? t("没有未读消息", "You’re all caught up")
                      : !messaging
                      ? t("团队消息暂不可用", "Team messaging is unavailable")
                      : view === "rooms"
                      ? t("还没有房间", "No rooms yet")
                      : t("还没有会话", "No conversations yet")}
                  </p>
                  {!search && !unreadOnly && messaging && (
                    <button
                      className="mt-4 text-sm text-neon-cyan"
                      onClick={() => setDialog("room")}
                    >
                      {t("创建第一个房间", "Create your first room")}
                    </button>
                  )}
                </div>
              )}
              {visible.map((c) => (
                <Link
                  key={c.id}
                  href={teamHref(space.id, view, c.id)}
                  aria-current={selectedId === c.id ? "page" : undefined}
                  className={`mb-1 flex items-start gap-3 rounded-xl p-3 ${
                    selectedId === c.id
                      ? "bg-neon-cyan/10"
                      : "hover:bg-glass-bg"
                  }`}
                >
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-glass-border bg-glass-bg text-neon-cyan">
                    {c.kind === "dm" ? (
                      <MessageCircle size={19} />
                    ) : c.visibility === "private" ? (
                      <LockKeyhole size={19} />
                    ) : (
                      <Hash size={19} />
                    )}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium">
                        {title(c)}
                      </span>
                      {c.unread_count > 0 && (
                        <span className="ml-auto shrink-0 rounded-full bg-neon-cyan/15 px-1.5 text-[10px] text-neon-cyan">
                          {c.unread_count > 99 ? "99+" : c.unread_count}
                        </span>
                      )}
                    </div>
                    <p className="mt-1 truncate text-xs text-text-secondary">
                      {c.last_message ||
                        t("暂无消息，开始讨论吧", "Start the conversation")}
                    </p>
                  </div>
                </Link>
              ))}
            </div>
            <button
              className="m-3 flex items-center justify-center gap-2 rounded-xl border border-dashed border-glass-border py-3 text-xs text-text-secondary hover:text-neon-cyan disabled:opacity-40"
              disabled={!messaging}
              onClick={() => setDialog(view === "rooms" ? "dm" : "room")}
            >
              <Plus size={15} />
              {view === "rooms"
                ? t("发起私聊", "New direct message")
                : t("创建房间", "Create room")}
            </button>
          </section>
          <main
            className={`relative min-h-0 min-w-0 flex-1 ${
              selectedId ? "" : "max-md:hidden"
            }`}
          >
            {current && !error ? (
              <TeamThread
                key={`${space.id}:${current.id}`}
                spaceId={space.id}
                conversation={current}
                userId={user.id}
                users={members.users}
                onBack={() => router.push(teamHref(space.id, view))}
                onUpdated={() => void reload(true)}
              />
            ) : (
              <div className="flex h-full flex-col items-center justify-center overflow-y-auto p-8 text-center">
                <div className="mb-6 rounded-3xl border border-glass-border bg-glass-bg p-6 text-neon-cyan">
                  <MessageSquare size={40} strokeWidth={1.4} />
                </div>
                <h2 className="max-w-lg break-words text-2xl font-semibold">
                  {selectedId
                    ? loading
                      ? t("正在打开会话…", "Opening conversation…")
                      : t("会话暂不可用", "Conversation unavailable")
                    : t(
                        `在 ${space.name} 开始协作`,
                        `Collaborate in ${space.name}`
                      )}
                </h2>
                <p className="mt-3 max-w-md text-sm leading-6 text-text-secondary">
                  {selectedId
                    ? t(
                        "从左侧选择会话，或刷新以确认访问权限。",
                        "Select a conversation or refresh to check your access."
                      )
                    : !messaging
                    ? t(
                        "团队消息服务尚未开放。你仍可管理成员与 Agent。",
                        "Team messaging is not available yet. You can manage members and Agents."
                      )
                    : t(
                        "在房间里讨论项目，或与组织成员私聊。",
                        "Discuss projects in rooms or message a teammate directly."
                      )}
                </p>
                <div className="mt-7 flex flex-wrap justify-center gap-3">
                  {selectedId ? (
                    <button
                      className={teamButton}
                      onClick={() => router.push(teamHref(space.id, view))}
                    >
                      {t("返回会话列表", "Back to conversations")}
                    </button>
                  ) : (
                    <>
                      {messaging && (
                        <button
                          className={`${teamButton} bg-neon-cyan/10 text-neon-cyan`}
                          onClick={() => setDialog("room")}
                        >
                          <Plus size={16} />
                          {t("创建房间", "Create room")}
                        </button>
                      )}
                      <Link
                        className={teamButton}
                        href={teamHref(space.id, "members")}
                      >
                        <Users size={16} />
                        {canManage(space)
                          ? t("邀请成员", "Invite teammates")
                          : t("查看成员", "View members")}
                      </Link>
                    </>
                  )}
                </div>
                {!selectedId && (
                  <p className="mt-10 text-xs text-text-secondary">
                    {activeUsers} {t("位成员", "members")} · {activeAgents}{" "}
                    Agent
                  </p>
                )}
              </div>
            )}
          </main>
        </>
      ) : (
        <main className="min-h-0 min-w-0 flex-1 overflow-y-auto">
          <header className="flex h-[76px] items-center justify-between border-b border-glass-border px-6">
            <h1 className="font-semibold">
              {view === "members"
                ? t("组织成员", "Organization members")
                : view === "agents"
                ? t("组织 Agent", "Organization Agents")
                : t("组织设置", "Organization settings")}
            </h1>
            <Link className="text-sm text-neon-cyan" href={teamHref(space.id)}>
              {t("返回消息", "Back to messages")}
            </Link>
          </header>
          <div className="p-4 sm:p-6">
            <TeamSpacesPage
              teamMode
              section={view}
              onChanged={onMembershipChanged}
            />
          </div>
        </main>
      )}
      {dialog && (
        <TeamConversationDialog
          spaceId={space.id}
          kind={dialog}
          users={members.users}
          userId={user.id}
          onClose={() => setDialog(null)}
          onCreated={(conversation) => {
            setConversations((previous) => [
              conversation,
              ...previous.filter((c) => c.id !== conversation.id),
            ]);
            setDialog(null);
            setUnreadOnly(false);
            setSearch("");
            router.push(
              teamHref(
                space.id,
                conversation.kind === "room" ? "rooms" : "messages",
                conversation.id
              )
            );
            void reload(true);
          }}
        />
      )}
    </div>
  );
}
