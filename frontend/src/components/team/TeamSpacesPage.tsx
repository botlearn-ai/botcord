"use client";
import CopyableId from "@/components/ui/CopyableId";
import PageHeader from "@/components/ui/PageHeader";
import IconTile from "@/components/ui/IconTile";
import Alert from "@/components/ui/Alert";
import Button from "@/components/ui/Button";
import Card from "@/components/ui/Card";
import Disclosure from "@/components/ui/Disclosure";
import EmptyState from "@/components/ui/EmptyState";
import Field from "@/components/ui/Field";
import IconButton from "@/components/ui/IconButton";
import { Input } from "@/components/ui/Input";
import Switch from "@/components/ui/Switch";

import LinkButton from "@/components/ui/LinkButton";
import Select from "@/components/ui/Select";
import { useLanguage } from "@/lib/i18n";
import { subscribeToPageReturn } from "@/lib/page-return";
import {
  canManage,
  canRemoveUser,
  spaceError,
  teamSpacesApi,
  type MembershipStatus,
} from "@/lib/team-spaces";
import {
  createTeamSpaceStore,
  type TeamSpaceStore,
} from "@/store/team-space-store";
import {
  useConfirm,
  useConfirmStore,
  type ConfirmOptions,
} from "@/store/useConfirmStore";
import {
  ArrowRight,
  Bot,
  Building2,
  Loader2,
  Plus,
  RefreshCw,
  ShieldCheck,
  UserRound,
  Users,
} from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "zustand";
import AccessOverviewSection from "./AccessOverviewSection";
import OrgInviteLinks from "./OrgInviteLinks";
import TeamWorkspaceSkeleton from "./TeamWorkspaceSkeleton";

export default function TeamSpacesPage({
  teamMode = false,
  section,
  onChanged,
  sharedStore,
}: {
  teamMode?: boolean;
  sharedStore?: TeamSpaceStore;
  section?: "members" | "settings";
  onChanged?: () => void;
}) {
  const zh = useLanguage() === "zh";
  const t = (cn: string, en: string) => (zh ? cn : en);
  const router = useRouter();
  const query = useSearchParams();
  const requestedId = query.get("space");
  const store = useMemo(
    () => sharedStore ?? createTeamSpaceStore(teamMode),
    [sharedStore, teamMode],
  );
  const {
    snapshot: loadedSnapshot,
    loading,
    refreshing,
    error,
    load,
    refresh,
  } = useStore(store);
  const snapshot =
    loadedSnapshot &&
    (requestedId
      ? loadedSnapshot.selected.id === requestedId
      : teamMode || loadedSnapshot.selected.kind === "personal")
      ? loadedSnapshot
      : null;
  const currentRoute = useRef(requestedId);
  currentRoute.current = requestedId;
  const confirm = useConfirm();
  const pendingConfirmation =
    useRef<ReturnType<typeof useConfirmStore.getState>["current"]>(null);
  const [actionBusy, setBusy] = useState(false);
  const busy = actionBusy || refreshing;
  const locked = useRef(false);
  const mounted = useRef(false);
  const [notice, setNotice] = useState<{ error: boolean; text: string } | null>(
    null,
  );
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [humanId, setHumanId] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [showJoin, setShowJoin] = useState(false);
  const createNameRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (showCreate) createNameRef.current?.focus();
  }, [showCreate]);
  const basePath = teamMode ? "/chats/team" : "/settings/spaces";

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (!sharedStore) store.getState().cancel();
    };
  }, [store, sharedStore]);
  useEffect(() => {
    setNotice(null);
    setHumanId("");
    if (!sharedStore) void load(requestedId);
    return () => {
      if (!sharedStore) store.getState().cancel();
      if (
        pendingConfirmation.current &&
        useConfirmStore.getState().current === pendingConfirmation.current
      ) {
        useConfirmStore.getState().close(false);
      }
      pendingConfirmation.current = null;
    };
  }, [load, requestedId, store, sharedStore]);
  // Window focus also fires when returning from DevTools. Only a real page return
  // may refresh; the store coalesces requests and keeps the current page visible.
  useEffect(
    () =>
      subscribeToPageReturn(() => {
        if (!sharedStore && !locked.current) void refresh(requestedId);
      }),
    [refresh, requestedId, sharedStore],
  );

  const select = (id: string) =>
    router.push(
      teamMode && snapshot?.spaces.find((s) => s.id === id)?.kind === "personal"
        ? basePath
        : `${basePath}?space=${encodeURIComponent(id)}`,
    );
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
        await load(origin, { background: Boolean(sharedStore) });
        if (!sharedStore && mounted.current && currentRoute.current === origin)
          onChanged?.();
      }
    } catch (cause) {
      if (mounted.current && currentRoute.current === origin) {
        // Reload after a rejected mutation so revoked roles and stale policies disappear.
        await load(origin, { background: Boolean(sharedStore) });
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

  if (teamMode && loading && !section) return <TeamWorkspaceSkeleton />;

  return (
    <div className="mx-auto max-w-5xl space-y-6 pb-12">
      {!section && (
        <PageHeader
          eyebrow="Team"
          title={
            teamMode
              ? t("团队空间", "Team workspace")
              : t("空间与组织", "Spaces & organizations")
          }
          description={t(
            "使用同一个账户和 Agent，分别管理个人与组织身份。",
            "Use the same account and Agents with separate personal and organization memberships.",
          )}
          actions={
            <Button
              variant="primary"
              disabled={busy || loading || !snapshot}
              onClick={() => setShowCreate(!showCreate)}
              aria-expanded={showCreate}
            >
              <Plus size={16} />
              {t("创建组织", "Create organization")}
            </Button>
          }
        />
      )}

      {notice && (
        <Alert tone={notice.error ? "danger" : "success"}>{notice.text}</Alert>
      )}
      {loading && (
        <Card role="status" className="flex items-center gap-3">
          <Loader2 size={20} className="animate-spin" />
          {t("正在加载空间…", "Loading spaces…")}
        </Card>
      )}
      {error != null && (
        <Alert tone="danger" className="space-y-4">
          <p>{spaceError(error, zh)}</p>
          <div className="flex flex-wrap gap-3">
            <Button
              variant="secondary"

              disabled={busy}
              onClick={() => void load(requestedId)}
            >
              <RefreshCw size={16} />
              {t("重试", "Retry")}
            </Button>
            <LinkButton variant="secondary" href={basePath}>
              {t("返回我的空间", "My spaces")}
            </LinkButton>
            <LinkButton variant="secondary" href="/login">
              {t("重新登录", "Sign in")}
            </LinkButton>
          </div>
        </Alert>
      )}

      {snapshot && space && (
        <>
          {!section && !(teamMode && personal) && (
            <Card
              as="section"
              className="flex flex-wrap items-center justify-between gap-4"
              aria-label={t("选择空间", "Choose space")}
            >
              <div className="flex min-w-0 flex-1 items-center gap-3">
                <IconTile>
                  {personal ? <UserRound /> : <Building2 />}
                </IconTile>
                <Field label={<>{t("当前空间", "Current space")}</>}>
                  <Select
                    aria-label={t("当前空间", "Current space")}

                    value={space.id}
                    disabled={busy}
                    onChange={(e) => select(e.target.value)}
                  >
                    {snapshot.spaces
                      .filter((s) => !teamMode || s.kind === "organization")
                      .map((s) => (
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
                  </Select>
                </Field>
              </div>
              <IconButton
                disabled={busy}
                onClick={() => void load(requestedId)}
                label={t("刷新空间", "Refresh spaces")}
              >
                <RefreshCw size={16} />
              </IconButton>
            </Card>
          )}

          {!section &&
            snapshot.spaces.some(
              (s) => s.membership.status === "invited" && s.id !== space.id,
            ) && (
              <Card
                as="section"
                className="space-y-3"
                aria-label={t("待接受邀请", "Pending invitations")}
              >
                <h2 className="font-semibold">
                  {t("待接受邀请", "Pending invitations")}
                </h2>
                {snapshot.spaces
                  .filter(
                    (s) =>
                      s.membership.status === "invited" && s.id !== space.id,
                  )
                  .map((s) => (
                    <div
                      key={s.id}
                      className="flex items-center justify-between gap-3"
                    >
                      <span className="min-w-0 break-words text-sm">
                        {s.name}
                      </span>
                      <Button
                        variant="secondary"

                        disabled={busy}
                        onClick={() => select(s.id)}
                      >
                        {t("查看邀请", "Review invitation")}
                        <ArrowRight size={16} />
                      </Button>
                    </div>
                  ))}
              </Card>
            )}

          {teamMode && personal && (
            <section className="mx-auto w-full max-w-3xl py-8 sm:py-16">
              <PageHeader
                align="center"
                level={2}
                className="mb-8"
                icon={
                  <IconTile size="lg">
                    <Building2 />
                  </IconTile>
                }
                title={t("开启你的团队空间", "Start your team workspace")}
                description={t(
                  "还没有加入组织。创建一个新组织，或接受邀请，在团队房间里与成员交流。",
                  "You haven’t joined an organization yet. Create one or accept an invitation to talk with teammates in rooms.",
                )}
              />
              <div className="grid gap-4 sm:grid-cols-2">
                <Card
                  as="button"
                  variant="interactive"
                  disabled={busy}
                  aria-expanded={showCreate}
                  onClick={() => {
                    setShowCreate(true);
                    setShowJoin(false);
                  }}
                >
                  <Plus size={24} className="mb-5 text-accent-text" />
                  <h3 className="text-lg font-semibold">
                    {t("创建组织", "Create organization")}
                  </h3>
                  <p className="mt-2 text-sm leading-6 text-text-secondary">
                    {t(
                      "为你的团队建立空间，邀请成员并添加 Agent。",
                      "Set up a space for your team, invite people and add Agents.",
                    )}
                  </p>
                  <span className="mt-5 inline-flex items-center gap-2 text-sm text-accent-text">
                    {t("开始创建", "Get started")} <ArrowRight size={16} />
                  </span>
                </Card>
                <Card
                  as="button"
                  variant="interactive"
                  disabled={busy}
                  aria-expanded={showJoin}
                  onClick={() => {
                    setShowJoin(true);
                    setShowCreate(false);
                  }}
                >
                  <Users size={24} className="mb-5 text-accent-text" />
                  <h3 className="text-lg font-semibold">
                    {t("加入组织", "Join organization")}
                  </h3>
                  <p className="mt-2 text-sm leading-6 text-text-secondary">
                    {t(
                      "已经有团队？向管理员索取邀请链接，或让管理员邀请你加入。",
                      "Already have a team? Ask an administrator for an invite link or an invitation.",
                    )}
                  </p>
                  <span className="mt-5 inline-flex items-center gap-2 text-sm text-accent-text">
                    {t("查看加入方式", "How to join")} <ArrowRight size={16} />
                  </span>
                </Card>
              </div>
              {showJoin && (
                <Card className="mt-4 space-y-4">
                  <h3 className="font-semibold">
                    {t("通过邀请加入组织", "Join by invitation")}
                  </h3>
                  <p className="text-sm leading-6 text-text-secondary">
                    {t(
                      "最简单的方式是打开管理员发来的邀请链接。也可以将下方用户 ID 发给组织管理员，收到邀请后刷新此页即可查看并接受。",
                      "The easiest way is to open an invite link from an administrator. Or share your user ID below; once invited, refresh this page to review and accept.",
                    )}
                  </p>
                  <Card variant="sunken" padding="sm">
                    <CopyableId
                      value={snapshot.human.human_id}
                      copyLabel={t("复制用户 ID", "Copy user ID")}
                      copiedLabel={t("已复制用户 ID", "User ID copied")}
                      copyFailedLabel={t("复制失败", "Could not copy user ID")}
                    />
                  </Card>
                  <Button
                    variant="primary"
                    disabled={busy || loading}
                    onClick={() => void load(requestedId)}
                  >
                    <RefreshCw size={16} />
                    {t("刷新邀请", "Refresh invitations")}
                  </Button>
                </Card>
              )}
            </section>
          )}

          {showCreate && (
            <Card>
              <form
                className="space-y-4"
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
                  <Field label={<>{t("组织名称", "Organization name")}</>}>
                    <Input
                      ref={createNameRef}
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      required
                      maxLength={128}
                      disabled={busy}
                      placeholder={t("例如：产品研发团队", "e.g. Product team")}
                    />
                  </Field>
                  <Field
                    label={<>{t("组织标识", "Organization address")}</>}
                    hint={
                      <>
                        <span className="block text-xs text-text-secondary">
                          {t(
                            "使用小写字母、数字或连字符，至少 2 个字符。",
                            "At least 2 characters: lowercase letters, numbers and hyphens.",
                          )}
                        </span>
                      </>
                    }
                  >
                    <Input
                      value={slug}
                      onChange={(e) => setSlug(e.target.value.toLowerCase())}
                      required
                      minLength={2}
                      maxLength={64}
                      pattern="[a-z0-9]+(-[a-z0-9]+)*"
                      disabled={busy}
                      placeholder="product-team"
                    />
                  </Field>
                </div>
                <p className="text-sm text-text-secondary">
                  {t(
                    "你将成为组织所有者。成员和 Agent 需要分别加入。",
                    "You will be the owner. People and Agents join separately.",
                  )}
                </p>
                <Button
                  type="submit"
                  variant="primary"

                  disabled={busy || !name.trim() || !slug.trim()}
                >
                  {busy && <Loader2 size={16} className="animate-spin" />}
                  {t("创建", "Create")}
                </Button>
              </form>
            </Card>
          )}

          {!section && !(teamMode && personal) && (
            <section className="flex flex-wrap items-center justify-between gap-3 px-1 text-sm text-text-secondary">
              <span>{snapshot.user.display_name}</span>
              <span>
                {personal
                  ? t("个人身份", "Personal membership")
                  : space.roles.map(role).join(" · ") ||
                    status(space.membership.status)}
              </span>
            </section>
          )}

          {space.status !== "active" ? (
            <Card>
              {t(
                "此空间已暂停或归档，暂不可进行成员管理。",
                "This space is suspended or archived. Membership management is unavailable.",
              )}
            </Card>
          ) : space.membership.status === "invited" ? (
            <Card as="section" className="space-y-4">
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
                  "私聊查阅：",
                  "Admin access to organization DMs: ",
                )}
                {space.admin_dm_content_access_enabled
                  ? t(
                      "已开启；适用于仍保留的全部组织私聊历史。",
                      "Enabled for all retained organization DM history.",
                    )
                  : t("已关闭。", "Disabled.")}
              </p>
              <Button
                variant="primary"

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
              </Button>
            </Card>
          ) : active && personal ? (
            teamMode ? null : (
              <Card as="section" className="space-y-4">
                <h2 className="text-lg font-semibold">
                  {t("你的个人空间", "Your personal space")}
                </h2>
                <p className="text-sm leading-6 text-text-secondary">
                  {t(
                    "个人对话、联系人和 Agent 保留在这里。加入组织不会转移你的个人资料或 Agent 所有权。",
                    "Your personal conversations, contacts and Agents stay here. Joining an organization does not transfer your personal data or Agent ownership.",
                  )}
                </p>
                <LinkButton variant="primary" href="/chats/messages">
                  {t("进入个人对话", "Open personal conversations")}
                  <ArrowRight size={16} />
                </LinkButton>
              </Card>
            )
          ) : (
            active && (
              <>
                {!section && (
                  <Card>
                    <strong>{t("组织工作区", "Organization workspace")}</strong>
                    <p className="text-text-secondary">
                      {t(
                        "在 Team 中查看消息与房间，在这里管理成员、Agent 和组织设置。Agent 的 owner 可以授权成员通过私信使用自己的 Agent。",
                        "Open Team for messages and rooms. Manage members, Agents and organization settings here. Agent owners can share their Agents with members through direct messages.",
                      )}
                    </p>
                    <LinkButton
                      variant="inline"
                      className="mt-2"
                      href={`/chats/team?space=${encodeURIComponent(space.id)}`}
                    >
                      {t("进入团队消息", "Open team messages")}{" "}
                      <ArrowRight size={14} />
                    </LinkButton>
                  </Card>
                )}

                {(!section || section === "members") && (
                  <Card as="section" className="space-y-5">
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
                    {manager ? (
                      <>
                        <OrgInviteLinks
                          spaceId={space.id}
                          spaceName={space.name}
                        />
                        <Disclosure
                          title={
                            <>
                              {t(
                                "已注册用户：按用户 ID 邀请",
                                "Registered users: invite by user ID",
                              )}
                            </>
                          }
                        >
                          <div className="pt-3">
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
                                    "邀请已创建；对方进入 Team 后即可查看并接受。",
                                    "Invitation created. They can review and accept it in Team.",
                                  ),
                                );
                              }}
                            >
                              <Field
                                label={<>{t("邀请用户", "Invite a person")}</>}
                                hint={
                                  <>
                                    <span
                                      id="invite-help"
                                      className="block text-xs text-text-secondary"
                                    >
                                      {t(
                                        "请对方提供账户菜单中的用户 ID。",
                                        "Ask for the user ID shown in their account menu.",
                                      )}
                                    </span>
                                  </>
                                }
                              >
                                <Input
                                  aria-describedby="invite-help"
                                  value={humanId}
                                  onChange={(e) => setHumanId(e.target.value)}
                                  required
                                  pattern="hu_[a-zA-Z0-9]+"
                                  maxLength={32}
                                  placeholder="hu_…"
                                  disabled={busy}
                                />
                              </Field>
                              <Button
                                type="submit"
                                variant="primary"

                                disabled={busy || !humanId.trim()}
                              >
                                {t("发送邀请", "Invite")}
                              </Button>
                            </form>
                          </div>
                        </Disclosure>
                      </>
                    ) : (
                      <EmptyState
                        compact
                        title={
                          <>
                            {t(
                              "请联系管理员获取邀请链接。",
                              "Ask an administrator for an invite link.",
                            )}
                          </>
                        }
                      />
                    )}
                    <ul className="divide-y divide-border">
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
                              {member.roles.map(role).join(" / ") ||
                                t("成员", "Member")}{" "}
                              · {status(member.status)}
                            </p>
                          </div>
                          {canRemoveUser(space, member, snapshot.user.id) && (
                            <Button
                              variant="danger"

                              disabled={busy}
                              onClick={() =>
                                void run(
                                  async () => {
                                    const self =
                                      member.user_id === snapshot.user.id;
                                    if (
                                      !(await confirmForSpace({
                                        title: self
                                          ? t(
                                              "退出组织？",
                                              "Leave organization?",
                                            )
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
                            </Button>
                          )}
                        </li>
                      ))}
                    </ul>
                  </Card>
                )}

                {!section && (
                  <LinkButton
                    variant="row"

                    href={`/chats/team?space=${encodeURIComponent(space.id)}&view=agents`}
                  >
                    <span className="flex items-center gap-3">
                      <IconTile>
                        <Bot />
                      </IconTile>
                      <span className="min-w-0 flex-1">
                        <span className="block font-semibold">
                          {t("组织 Agent", "Organization Agents")}
                        </span>
                        <span className="mt-1 block text-sm text-text-secondary">
                          {t(
                            "添加 Agent、授权成员使用、设置回复方式。",
                            "Add Agents, share them with members and choose when they reply.",
                          )}
                        </span>
                      </span>
                      <span className="inline-flex shrink-0 items-center gap-1 text-sm text-accent-text">
                        {t("在 Agent 页面管理", "Manage on the Agent page")}
                        <ArrowRight size={16} />
                      </span>
                    </span>
                  </LinkButton>
                )}

                {(!section || section === "settings") && (
                  <Card as="section" className="space-y-5">
                    <h2 className="flex items-center gap-2 text-lg font-semibold">
                      <ShieldCheck size={20} />
                      {t("组织设置", "Organization settings")}
                    </h2>
                    <div className="flex flex-wrap items-start justify-between gap-4">
                      <div className="max-w-xl">
                        <h3 className="font-medium">
                          {t(
                            "私聊查阅",
                            "Admin access to organization DMs",
                          )}
                        </h3>
                        <p className="mt-2 text-sm leading-6 text-text-secondary">
                          {t(
                            "开启后，所有者和管理员获得查看权限。范围为全部仍保留的组织私聊记录。不影响个人对话、私人文件和其他组织。",
                            "When enabled, organization owners and admins can view all retained organization DM history through a dedicated entry. Personal conversations, private files and other organizations are unaffected.",
                          )}
                        </p>
                      </div>
                      <Switch
                        checked={space.admin_dm_content_access_enabled}
                        aria-label={t(
                          "私聊查阅",
                          "Admin access to organization DMs",
                        )}
                        disabled={busy || !owner}
                        onCheckedChange={() =>
                          void run(
                            async () => {
                              const enabled =
                                !space.admin_dm_content_access_enabled;
                              if (
                                !(await confirmForSpace({
                                  title: enabled
                                    ? t(
                                        "允许查阅",
                                        "Enable organization DM access?",
                                      )
                                    : t(
                                        "关闭查阅",
                                        "Disable organization DM access?",
                                      ),
                                  message: enabled
                                    ? t(
                                        "允许所有者和管理员查看组织私聊。包含全部仍保留的历史记录。所有成员可见此设置，修改会留记录。查看入口暂未开放。",
                                        "This covers all retained organization DM history. Members can see this setting and the change is recorded. The content viewing entry is not available yet.",
                                      )
                                    : t(
                                        "关闭后，管理员失去这项额外查看权限。此前的操作记录仍会保留。",
                                        "Admins lose this additional access. Existing audit records are retained.",
                                      ),
                                  confirmLabel: enabled
                                    ? t("允许查阅", "Enable access")
                                    : t("关闭查阅", "Disable access"),
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
                              "设置已保存",
                              "Organization settings updated.",
                            ),
                          )
                        }
                        label={
                          space.admin_dm_content_access_enabled
                            ? t("已开启", "On")
                            : t("已关闭", "Off")
                        }
                      />
                    </div>
                    <p className="text-xs leading-5 text-text-secondary">
                      {t(
                        "仅组织所有者可修改。可保存设置，查看入口暂未开放。",
                        "Only the organization owner can change this setting. It can be saved now; the DM content viewing entry is not available yet.",
                      )}
                    </p>
                    <div className="flex justify-between gap-4 border-t border-border pt-4 text-sm">
                      <span>
                        {t(
                          "代表组织对外通信",
                          "External communication for the organization",
                        )}
                      </span>
                      <span className="text-text-secondary">
                        {t("暂未开放", "Not available")}
                      </span>
                    </div>
                    {manager && <AccessOverviewSection spaceId={space.id} />}
                  </Card>
                )}
              </>
            )
          )}
        </>
      )}
    </div>
  );
}
