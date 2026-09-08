"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import {
  Building2,
  UserRound,
  Users,
  Bot,
  ShieldCheck,
  Loader2,
  RefreshCw,
  Plus,
  ArrowRight,
} from "lucide-react";
import { useStore } from "zustand";
import { useLanguage } from "@/lib/i18n";
import {
  canManage,
  canRemoveUser,
  spaceError,
  teamSpacesApi,
  type MembershipStatus,
} from "@/lib/team-spaces";
import { createTeamSpaceStore } from "@/store/team-space-store";
import {
  useConfirm,
  useConfirmStore,
  type ConfirmOptions,
} from "@/store/useConfirmStore";

const panel = "rounded-2xl border border-glass-border bg-glass-bg p-5 sm:p-6";
const input =
  "w-full rounded-xl border border-glass-border bg-deep-black px-3 py-2.5 text-sm text-text-primary outline-none focus:border-neon-cyan focus:ring-2 focus:ring-neon-cyan/20 disabled:opacity-50";
const button =
  "inline-flex items-center justify-center gap-2 rounded-xl border border-glass-border px-4 py-2.5 text-sm font-medium transition-colors hover:bg-neon-cyan/10 focus-visible:outline-2 focus-visible:outline-neon-cyan disabled:cursor-not-allowed disabled:opacity-50";
const primary = `${button} border-neon-cyan/30 bg-neon-cyan/10 text-neon-cyan`;

export default function TeamSpacesPage() {
  const zh = useLanguage() === "zh";
  const t = (cn: string, en: string) => (zh ? cn : en);
  const router = useRouter();
  const query = useSearchParams();
  const requestedId = query.get("space");
  const store = useMemo(createTeamSpaceStore, []);
  const { snapshot: loadedSnapshot, loading, error, load } = useStore(store);
  const snapshot =
    loadedSnapshot &&
    (requestedId
      ? loadedSnapshot.selected.id === requestedId
      : loadedSnapshot.selected.kind === "personal")
      ? loadedSnapshot
      : null;
  const currentRoute = useRef(requestedId);
  currentRoute.current = requestedId;
  const confirm = useConfirm();
  const pendingConfirmation =
    useRef<ReturnType<typeof useConfirmStore.getState>["current"]>(null);
  const [busy, setBusy] = useState(false);
  const locked = useRef(false);
  const mounted = useRef(false);
  const [notice, setNotice] = useState<{ error: boolean; text: string } | null>(
    null,
  );
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [humanId, setHumanId] = useState("");
  const [agentId, setAgentId] = useState("");
  const [showCreate, setShowCreate] = useState(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      store.getState().cancel();
    };
  }, [store]);
  useEffect(() => {
    setNotice(null);
    setHumanId("");
    setAgentId("");
    void load(requestedId);
    return () => {
      store.getState().cancel();
      if (
        pendingConfirmation.current &&
        useConfirmStore.getState().current === pendingConfirmation.current
      ) {
        useConfirmStore.getState().close(false);
      }
      pendingConfirmation.current = null;
    };
  }, [load, requestedId, store]);
  // Refresh membership and policy on return from another tab, without interrupting an action.
  useEffect(() => {
    const refresh = () => {
      if (!locked.current) void load(requestedId);
    };
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [load, requestedId]);

  const select = (id: string) =>
    router.push(`/settings/spaces?space=${encodeURIComponent(id)}`);
  async function confirmForSpace(options: ConfirmOptions) {
    const origin = currentRoute.current;
    const result = confirm({
      ...options,
      message: `${snapshot?.selected.name ?? ""}\n\n${options.message ?? ""}`,
    });
    const request = useConfirmStore.getState().current;
    pendingConfirmation.current = request;
    const accepted = await result;
    if (pendingConfirmation.current === request)
      pendingConfirmation.current = null;
    return accepted && mounted.current && currentRoute.current === origin;
  }
  async function run(
    task: () => Promise<string | void | false>,
    success: string,
  ) {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setNotice(null);
    const origin = requestedId;
    try {
      const nextId = await task();
      if (
        !mounted.current ||
        currentRoute.current !== origin ||
        nextId === false
      )
        return;
      setNotice({ error: false, text: success });
      if (nextId) {
        setShowCreate(false);
        setName("");
        setSlug("");
        select(nextId);
      } else {
        await load(origin);
      }
    } catch (cause) {
      if (mounted.current && currentRoute.current === origin) {
        // Reload after a rejected mutation so revoked roles and stale policies disappear.
        await load(origin);
        if (mounted.current && currentRoute.current === origin)
          setNotice({ error: true, text: spaceError(cause, zh) });
      }
    } finally {
      locked.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  const status = (value: MembershipStatus) =>
    ({
      active: t("已加入", "Active"),
      invited: t("待确认", "Pending"),
      suspended: t("已暂停", "Suspended"),
      removed: t("已移除", "Removed"),
    })[value];
  const role = (value: string) =>
    ({
      owner: t("所有者", "Owner"),
      admin: t("管理员", "Admin"),
      member: t("成员", "Member"),
    })[value] ?? value;
  const space = snapshot?.selected;
  const personal = space?.kind === "personal";
  const active =
    space?.status === "active" && space.membership.status === "active";
  const manager = space ? canManage(space) : false;
  const owner = manager && space?.roles.includes("owner");
  const availableAgents =
    snapshot?.user.agents.filter(
      (agent) =>
        !snapshot.members.agents.some(
          (m) =>
            m.agent_id === agent.agent_id &&
            (m.status === "active" || m.status === "invited"),
        ),
    ) ?? [];

  return (
    <div className="mx-auto max-w-5xl space-y-6 pb-12">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="mb-2 text-xs font-semibold uppercase tracking-widest text-neon-cyan">
            Team
          </p>
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
            {t("空间与组织", "Spaces & organizations")}
          </h1>
          <p className="mt-2 max-w-xl text-sm leading-6 text-text-secondary">
            {t(
              "使用同一个账户和 Agent，分别管理个人与组织身份。",
              "Use the same account and Agents with separate personal and organization memberships.",
            )}
          </p>
        </div>
        <button
          className={primary}
          disabled={busy || loading || !snapshot}
          onClick={() => setShowCreate(!showCreate)}
          aria-expanded={showCreate}
        >
          <Plus size={16} />
          {t("创建组织", "Create organization")}
        </button>
      </header>

      {notice && (
        <div
          role={notice.error ? "alert" : "status"}
          className={`rounded-xl border p-4 text-sm ${notice.error ? "border-red-500/30 text-red-500" : "border-neon-cyan/30 text-neon-cyan"}`}
        >
          {notice.text}
        </div>
      )}
      {loading && (
        <div
          role="status"
          className={`${panel} flex items-center gap-3 text-text-secondary`}
        >
          <Loader2 size={20} className="animate-spin" />
          {t("正在加载空间…", "Loading spaces…")}
        </div>
      )}
      {error != null && (
        <div role="alert" className={`${panel} space-y-4`}>
          <p>{spaceError(error, zh)}</p>
          <div className="flex flex-wrap gap-3">
            <button
              className={button}
              disabled={busy}
              onClick={() => void load(requestedId)}
            >
              <RefreshCw size={16} />
              {t("重试", "Retry")}
            </button>
            <Link className={button} href="/settings/spaces">
              {t("返回我的空间", "My spaces")}
            </Link>
            <Link className={button} href="/login">
              {t("重新登录", "Sign in")}
            </Link>
          </div>
        </div>
      )}

      {snapshot && space && (
        <>
          <section
            className={`${panel} flex flex-wrap items-center justify-between gap-4`}
            aria-label={t("选择空间", "Choose space")}
          >
            <div className="flex min-w-0 flex-1 items-center gap-3">
              <div className="rounded-xl bg-neon-cyan/10 p-3 text-neon-cyan">
                {personal ? <UserRound size={22} /> : <Building2 size={22} />}
              </div>
              <label className="min-w-0 flex-1">
                <span className="mb-1 block text-xs text-text-secondary">
                  {t("当前空间", "Current space")}
                </span>
                <select
                  aria-label={t("当前空间", "Current space")}
                  className={input}
                  value={space.id}
                  disabled={busy}
                  onChange={(e) => select(e.target.value)}
                >
                  {snapshot.spaces.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.kind === "personal"
                        ? t("个人空间", "Personal space")
                        : s.name}
                      {s.membership.status === "invited"
                        ? t(" · 待接受邀请", " · Invitation")
                        : ""}
                      {s.status !== "active"
                        ? t(" · 不可用", " · Unavailable")
                        : ""}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <button
              className={button}
              disabled={busy}
              onClick={() => void load(requestedId)}
              aria-label={t("刷新空间", "Refresh spaces")}
            >
              <RefreshCw size={16} />
            </button>
          </section>

          {snapshot.spaces.some(
            (s) => s.membership.status === "invited" && s.id !== space.id,
          ) && (
            <section
              className={`${panel} space-y-3`}
              aria-label={t("待接受邀请", "Pending invitations")}
            >
              <h2 className="font-semibold">
                {t("待接受邀请", "Pending invitations")}
              </h2>
              {snapshot.spaces
                .filter(
                  (s) => s.membership.status === "invited" && s.id !== space.id,
                )
                .map((s) => (
                  <div
                    key={s.id}
                    className="flex items-center justify-between gap-3"
                  >
                    <span className="min-w-0 break-words text-sm">
                      {s.name}
                    </span>
                    <button
                      className={button}
                      disabled={busy}
                      onClick={() => select(s.id)}
                    >
                      {t("查看邀请", "Review invitation")}
                      <ArrowRight size={16} />
                    </button>
                  </div>
                ))}
            </section>
          )}

          {showCreate && (
            <form
              className={`${panel} space-y-4`}
              onSubmit={(e) => {
                e.preventDefault();
                void run(
                  async () =>
                    (await teamSpacesApi.create(name.trim(), slug.trim()))
                      .space_id,
                  t("组织已创建。", "Organization created."),
                );
              }}
            >
              <h2 className="text-lg font-semibold">
                {t("创建组织", "Create organization")}
              </h2>
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="space-y-2 text-sm">
                  <span>{t("组织名称", "Organization name")}</span>
                  <input
                    className={input}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    required
                    maxLength={128}
                    disabled={busy}
                    placeholder={t("例如：产品研发团队", "e.g. Product team")}
                  />
                </label>
                <label className="space-y-2 text-sm">
                  <span>{t("组织标识", "Organization address")}</span>
                  <input
                    className={input}
                    value={slug}
                    onChange={(e) => setSlug(e.target.value.toLowerCase())}
                    required
                    minLength={2}
                    maxLength={64}
                    pattern="[a-z0-9]+(-[a-z0-9]+)*"
                    disabled={busy}
                    placeholder="product-team"
                  />
                  <span className="block text-xs text-text-secondary">
                    {t(
                      "使用小写字母、数字或连字符，至少 2 个字符。",
                      "At least 2 characters: lowercase letters, numbers and hyphens.",
                    )}
                  </span>
                </label>
              </div>
              <p className="text-sm text-text-secondary">
                {t(
                  "你将成为组织所有者。成员和 Agent 需要分别加入。",
                  "You will be the owner. People and Agents join separately.",
                )}
              </p>
              <button
                className={primary}
                disabled={busy || !name.trim() || !slug.trim()}
              >
                {busy && <Loader2 size={16} className="animate-spin" />}
                {t("创建", "Create")}
              </button>
            </form>
          )}

          <section className="flex flex-wrap items-center justify-between gap-3 px-1 text-sm text-text-secondary">
            <span>
              {snapshot.user.display_name} · {t("你的用户 ID", "Your user ID")}
              ：
              <code className="select-all break-all text-text-primary">
                {snapshot.human.human_id}
              </code>
            </span>
            <span>
              {personal
                ? t("个人身份", "Personal membership")
                : space.roles.map(role).join(" · ") ||
                  status(space.membership.status)}
            </span>
          </section>

          {space.status !== "active" ? (
            <div className={panel}>
              {t(
                "此空间已暂停或归档，暂不可进行成员管理。",
                "This space is suspended or archived. Membership management is unavailable.",
              )}
            </div>
          ) : space.membership.status === "invited" ? (
            <section className={`${panel} space-y-4`}>
              <h2 className="text-xl font-semibold">
                {t("你受邀加入", "You are invited to join")} {space.name}
              </h2>
              <p className="text-sm leading-6 text-text-secondary">
                {t(
                  "接受后成为组织成员。你的个人 Agent 不会自动加入。",
                  "Accept to become a member. Your personal Agents will not join automatically.",
                )}
              </p>
              <p className="text-sm">
                {t(
                  "管理员访问组织私聊：",
                  "Admin access to organization DMs: ",
                )}
                {space.admin_dm_content_access_enabled
                  ? t(
                      "已开启；适用于仍保留的全部组织私聊历史。",
                      "Enabled for all retained organization DM history.",
                    )
                  : t("已关闭。", "Disabled.")}
              </p>
              <button
                className={primary}
                disabled={busy}
                onClick={() =>
                  void run(
                    async () => {
                      await teamSpacesApi.accept(space.id);
                    },
                    t("已加入组织。", "Joined organization."),
                  )
                }
              >
                {t("接受邀请", "Accept invitation")}
                <ArrowRight size={16} />
              </button>
            </section>
          ) : active && personal ? (
            <section className={`${panel} space-y-4`}>
              <h2 className="text-lg font-semibold">
                {t("你的个人空间", "Your personal space")}
              </h2>
              <p className="text-sm leading-6 text-text-secondary">
                {t(
                  "个人对话、联系人和 Agent 保留在这里。加入组织不会转移你的个人资料或 Agent 所有权。",
                  "Your personal conversations, contacts and Agents stay here. Joining an organization does not transfer your personal data or Agent ownership.",
                )}
              </p>
              <Link className={primary} href="/chats/messages">
                {t("进入个人对话", "Open personal conversations")}
                <ArrowRight size={16} />
              </Link>
            </section>
          ) : (
            active && (
              <>
                <div className="rounded-xl border border-neon-cyan/20 bg-neon-cyan/5 px-5 py-4 text-sm leading-6">
                  <strong>
                    {t(
                      "组织管理已开放",
                      "Organization management is available",
                    )}
                  </strong>
                  <p className="text-text-secondary">
                    {t(
                      "可以管理成员和 Agent 入组。组织聊天与任务执行暂未开放。",
                      "Manage memberships and Agent admission here. Organization chat and task execution are not available yet.",
                    )}
                  </p>
                </div>

                <section className={`${panel} space-y-5`}>
                  <h2 className="flex items-center gap-2 text-lg font-semibold">
                    <Users size={20} />
                    {t("成员", "Members")}
                    <span className="text-sm font-normal text-text-secondary">
                      {
                        snapshot.members.users.filter(
                          (m) => m.status === "active",
                        ).length
                      }
                    </span>
                  </h2>
                  {manager && (
                    <form
                      className="flex flex-wrap items-end gap-3"
                      onSubmit={(e) => {
                        e.preventDefault();
                        void run(
                          async () => {
                            await teamSpacesApi.invite(
                              space.id,
                              humanId.trim(),
                            );
                            setHumanId("");
                          },
                          t(
                            "邀请已创建；对方可在空间与组织页面接受。",
                            "Invitation created. They can accept it on the Spaces page.",
                          ),
                        );
                      }}
                    >
                      <label className="min-w-0 flex-1 space-y-2 text-sm">
                        <span>{t("邀请用户", "Invite a person")}</span>
                        <input
                          className={input}
                          aria-describedby="invite-help"
                          value={humanId}
                          onChange={(e) => setHumanId(e.target.value)}
                          required
                          pattern="hu_[a-zA-Z0-9]+"
                          maxLength={32}
                          placeholder="hu_…"
                          disabled={busy}
                        />
                        <span
                          id="invite-help"
                          className="block text-xs text-text-secondary"
                        >
                          {t(
                            "请对方提供账户菜单中的用户 ID。",
                            "Ask for the user ID shown in their account menu.",
                          )}
                        </span>
                      </label>
                      <button
                        className={primary}
                        disabled={busy || !humanId.trim()}
                      >
                        {t("发送邀请", "Invite")}
                      </button>
                    </form>
                  )}
                  <ul className="divide-y divide-glass-border">
                    {snapshot.members.users.map((member) => (
                      <li
                        key={member.id}
                        className="flex flex-wrap items-center justify-between gap-3 py-4"
                      >
                        <div className="min-w-0">
                          <p className="break-words font-medium">
                            {member.display_name}
                            {member.user_id === snapshot.user.id
                              ? t("（你）", " (you)")
                              : ""}
                          </p>
                          <p className="mt-1 break-all text-xs text-text-secondary">
                            {member.human_id} ·{" "}
                            {member.roles.map(role).join(" / ") ||
                              t("成员", "Member")}{" "}
                            · {status(member.status)}
                          </p>
                        </div>
                        {canRemoveUser(space, member, snapshot.user.id) && (
                          <button
                            className={`${button} text-red-500`}
                            disabled={busy}
                            onClick={() =>
                              void run(
                                async () => {
                                  const self =
                                    member.user_id === snapshot.user.id;
                                  if (
                                    !(await confirmForSpace({
                                      title: self
                                        ? t("退出组织？", "Leave organization?")
                                        : `${t("移除成员", "Remove member")}: ${member.display_name}`,
                                      message: t(
                                        "该成员及其 Agent 将失去组织访问权限，个人身份和数据保留。",
                                        "This member and their Agents will lose organization access. Personal identities and data are retained.",
                                      ),
                                      tone: "danger",
                                    }))
                                  )
                                    return false;
                                  await teamSpacesApi.removeUser(
                                    space.id,
                                    member.user_id,
                                  );
                                  if (self)
                                    return snapshot.spaces.find(
                                      (s) => s.kind === "personal",
                                    )?.id;
                                },
                                t("成员关系已更新。", "Membership updated."),
                              )
                            }
                          >
                            {member.user_id === snapshot.user.id
                              ? t("退出组织", "Leave")
                              : member.status === "invited"
                                ? t("撤销邀请", "Revoke invitation")
                                : t("移除", "Remove")}
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                </section>

                <section className={`${panel} space-y-5`}>
                  <h2 className="flex items-center gap-2 text-lg font-semibold">
                    <Bot size={20} />
                    {t("组织 Agent", "Organization Agents")}
                  </h2>
                  <p className="text-sm leading-6 text-text-secondary">
                    {t(
                      "由 Agent 所有者申请，组织管理员批准。加入后所有权仍属于本人。",
                      "Agent owners apply and organization managers approve. Ownership remains personal.",
                    )}
                  </p>
                  <form
                    className="flex flex-wrap items-end gap-3"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void run(
                        async () => {
                          await teamSpacesApi.requestAgent(space.id, agentId);
                          setAgentId("");
                        },
                        t(
                          "申请已提交，等待组织批准。",
                          "Application submitted for organization approval.",
                        ),
                      );
                    }}
                  >
                    <label className="min-w-0 flex-1 space-y-2 text-sm">
                      <span>
                        {t("选择自己的 Agent", "Choose one of your Agents")}
                      </span>
                      <select
                        className={input}
                        value={agentId}
                        onChange={(e) => setAgentId(e.target.value)}
                        disabled={busy || !availableAgents.length}
                        required
                      >
                        <option value="">
                          {availableAgents.length
                            ? t("请选择 Agent", "Select an Agent")
                            : t(
                                "暂无可申请的 Agent",
                                "No Agents available to apply",
                              )}
                        </option>
                        {availableAgents.map((a) => (
                          <option key={a.agent_id} value={a.agent_id}>
                            {a.display_name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <button className={primary} disabled={busy || !agentId}>
                      {t("申请加入", "Apply to join")}
                    </button>
                  </form>
                  {snapshot.members.agents.length === 0 ? (
                    <p className="rounded-xl border border-dashed border-glass-border p-6 text-center text-sm text-text-secondary">
                      {t(
                        "还没有 Agent。选择自己的 Agent 发起第一份申请。",
                        "No Agents yet. Apply with one of your own Agents to get started.",
                      )}
                    </p>
                  ) : (
                    <ul className="divide-y divide-glass-border">
                      {snapshot.members.agents.map((agent) => {
                        const sponsor = snapshot.members.users.find(
                          (u) => u.id === agent.sponsor_user_membership_id,
                        );
                        return (
                          <li
                            key={agent.id}
                            className="flex flex-wrap items-center justify-between gap-3 py-4"
                          >
                            <div className="min-w-0">
                              <p className="break-words font-medium">
                                {agent.display_name}
                              </p>
                              <p className="mt-1 text-xs text-text-secondary">
                                {t("所有者", "Owner")}:{" "}
                                {sponsor?.display_name ?? "—"} ·{" "}
                                {status(agent.status)}
                              </p>
                            </div>
                            <div className="flex flex-wrap gap-2">
                              {manager && agent.status === "invited" && (
                                <button
                                  className={primary}
                                  disabled={busy}
                                  onClick={() =>
                                    void run(
                                      async () => {
                                        await teamSpacesApi.approveAgent(
                                          space.id,
                                          agent.agent_id,
                                        );
                                      },
                                      t(
                                        "Agent 已加入组织。",
                                        "Agent joined the organization.",
                                      ),
                                    )
                                  }
                                >
                                  {t("批准加入", "Approve")}
                                </button>
                              )}
                              {(manager ||
                                sponsor?.user_id === snapshot.user.id) &&
                                agent.status !== "removed" && (
                                  <button
                                    className={button}
                                    disabled={busy}
                                    onClick={() =>
                                      void run(
                                        async () => {
                                          if (
                                            !(await confirmForSpace({
                                              title: `${t("移除 Agent", "Remove Agent")}: ${agent.display_name}`,
                                              message: t(
                                                "撤销组织成员关系，个人 Agent 和其他组织身份将保留。",
                                                "Revoke this membership. The personal Agent and other organization memberships will remain.",
                                              ),
                                              tone: "danger",
                                            }))
                                          )
                                            return false;
                                          await teamSpacesApi.removeAgent(
                                            space.id,
                                            agent.agent_id,
                                          );
                                        },
                                        t(
                                          "Agent 成员关系已更新。",
                                          "Agent membership updated.",
                                        ),
                                      )
                                    }
                                  >
                                    {agent.status === "invited"
                                      ? t("撤销申请", "Cancel application")
                                      : t("移除", "Remove")}
                                  </button>
                                )}
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </section>

                <section className={`${panel} space-y-5`}>
                  <h2 className="flex items-center gap-2 text-lg font-semibold">
                    <ShieldCheck size={20} />
                    {t("组织设置", "Organization settings")}
                  </h2>
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div className="max-w-xl">
                      <h3 className="font-medium">
                        {t(
                          "管理员访问组织私聊",
                          "Admin access to organization DMs",
                        )}
                      </h3>
                      <p className="mt-2 text-sm leading-6 text-text-secondary">
                        {t(
                          "开启后，组织所有者和管理员可通过专用入口查看仍保留的全部组织私聊历史。个人对话、私人文件和其他组织不受影响。",
                          "When enabled, organization owners and admins can view all retained organization DM history through a dedicated entry. Personal conversations, private files and other organizations are unaffected.",
                        )}
                      </p>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={space.admin_dm_content_access_enabled}
                      aria-label={t(
                        "管理员访问组织私聊",
                        "Admin access to organization DMs",
                      )}
                      className={`${button} ${space.admin_dm_content_access_enabled ? "border-neon-cyan/40 text-neon-cyan" : "text-text-secondary"}`}
                      disabled={busy || !owner}
                      onClick={() =>
                        void run(
                          async () => {
                            const enabled =
                              !space.admin_dm_content_access_enabled;
                            if (
                              !(await confirmForSpace({
                                title: enabled
                                  ? t(
                                      "开启组织私聊访问？",
                                      "Enable organization DM access?",
                                    )
                                  : t(
                                      "关闭组织私聊访问？",
                                      "Disable organization DM access?",
                                    ),
                                message: enabled
                                  ? t(
                                      "范围涵盖当前仍保留的全部组织私聊历史。所有成员可看到此设置，变更会被记录。内容查看入口尚未开放。",
                                      "This covers all retained organization DM history. Members can see this setting and the change is recorded. The content viewing entry is not available yet.",
                                    )
                                  : t(
                                      "关闭后管理员不再拥有此项额外访问权；已记录的审计信息保留。",
                                      "Admins lose this additional access. Existing audit records are retained.",
                                    ),
                                confirmLabel: enabled
                                  ? t("确认开启", "Enable access")
                                  : t("确认关闭", "Disable access"),
                              }))
                            )
                              return false;
                            await teamSpacesApi.policy(
                              space.organization_id!,
                              space.policy_version,
                              enabled,
                            );
                          },
                          t(
                            "组织设置已更新。",
                            "Organization settings updated.",
                          ),
                        )
                      }
                    >
                      {space.admin_dm_content_access_enabled
                        ? t("已开启", "On")
                        : t("已关闭", "Off")}
                    </button>
                  </div>
                  <p className="text-xs leading-5 text-text-secondary">
                    {t(
                      "仅组织所有者可修改。当前可保存设置，私聊内容查看入口尚未开放。",
                      "Only the organization owner can change this setting. It can be saved now; the DM content viewing entry is not available yet.",
                    )}
                  </p>
                  <div className="flex justify-between gap-4 border-t border-glass-border pt-4 text-sm">
                    <span>
                      {t(
                        "代表组织对外通信",
                        "External communication for the organization",
                      )}
                    </span>
                    <span className="text-text-secondary">
                      {t("未开放", "Not available")}
                    </span>
                  </div>
                </section>
              </>
            )
          )}
        </>
      )}
    </div>
  );
}
