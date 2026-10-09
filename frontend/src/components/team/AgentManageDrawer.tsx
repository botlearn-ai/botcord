"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Hash, Loader2, MessageCircle, Trash2, X } from "lucide-react";
import { useLanguage } from "@/lib/i18n";
import { spaceError, teamSpacesApi, type SpaceUser } from "@/lib/team-spaces";
import {
  replyModeLabel,
  replyRulesApi,
  teamAccessApi,
  type AgentRoomReply,
  type DirectoryAgent,
} from "@/lib/team-access";
import { useConfirm, useConfirmStore } from "@/store/useConfirmStore";
import AgentAccessGrants from "./AgentAccessGrants";
import AccessRequestsInbox from "./AccessRequestsInbox";
import RoomReplyModeControl from "./RoomReplyModeControl";
import { AgentIdentity } from "./AgentIdentity";
import { teamButton } from "./TeamConversationDialog";

export type ManageTab = "overview" | "access" | "rooms" | "danger";

/** Tabs the viewer may open: owners see everything, managers can only remove others' Agents. */
export function manageTabs(isOwner: boolean, canRemove: boolean): ManageTab[] {
  if (isOwner) return ["overview", "access", "rooms", "danger"];
  return canRemove ? ["overview", "danger"] : ["overview"];
}

/**
 * Side drawer (full-screen on mobile) for one organization Agent: overview,
 * who may use it (requests + grants), rooms with reply modes and per-sender
 * rules, and removal from the organization.
 */
export default function AgentManageDrawer({
  spaceId,
  agent,
  isOwner,
  canRemove,
  pending,
  users,
  userId,
  initialTab = "overview",
  chatBusy,
  onChat,
  onChanged,
  onRemoved,
  onClose,
}: {
  spaceId: string;
  agent: DirectoryAgent;
  isOwner: boolean;
  canRemove: boolean;
  pending: number;
  users: SpaceUser[];
  userId: string;
  initialTab?: ManageTab;
  chatBusy: boolean;
  onChat: (() => void) | null;
  /** Grants or requests changed: refetch the directory row. */
  onChanged: () => void;
  onRemoved: () => void;
  onClose: () => void;
}) {
  const zh = useLanguage() === "zh";
  const t = (cn: string, en: string) => (zh ? cn : en);
  const tabs = manageTabs(isOwner, canRemove);
  const [tab, setTab] = useState<ManageTab>(tabs.includes(initialTab) ? initialTab : "overview");
  const [grantsVersion, setGrantsVersion] = useState(0);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      // Modal dialogs and confirms opened from the drawer handle their own Escape.
      if (e.key !== "Escape" || document.querySelector("dialog[open]") || useConfirmStore.getState().current) return;
      onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const tabLabel: Record<ManageTab, string> = {
    overview: t("概览", "Overview"),
    access: t("谁可以用", "Who can use"),
    rooms: t("房间与回复", "Rooms & replies"),
    danger: t("危险操作", "Danger zone"),
  };
  const stat = (value: number | string, label: string, accent = false) => (
    <div className="rounded-xl border border-glass-border bg-glass-bg px-3 py-3">
      <p className={`text-xl font-semibold tabular-nums ${accent ? "text-neon-cyan" : ""}`}>{value}</p>
      <p className="mt-0.5 text-xs text-text-secondary">{label}</p>
    </div>
  );

  return (
    <>
      <div className="liquid-scrim fixed inset-0 z-40 backdrop-blur-[2px]" onClick={onClose} aria-hidden />
      <aside
        className="liquid-drawer fixed inset-y-0 right-0 z-50 flex w-full flex-col border-glass-border sm:max-w-lg sm:border-l"
        role="dialog"
        aria-modal="true"
        aria-label={t(`管理 ${agent.display_name}`, `Manage ${agent.display_name}`)}
      >
        <header className="liquid-toolbar flex items-center gap-3 border-b border-glass-border px-4 py-4 sm:px-5">
          <AgentIdentity agent={agent} size={44} className="min-w-0 flex-1" />
          <button
            ref={closeRef}
            onClick={onClose}
            aria-label={t("关闭", "Close")}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-text-secondary transition-colors hover:bg-glass-bg hover:text-text-primary"
          >
            <X size={18} />
          </button>
        </header>
        {tabs.length > 1 && (
          <nav
            className="flex shrink-0 gap-1 overflow-x-auto [scrollbar-width:none] border-b border-glass-border px-3 py-2 sm:px-4"
            aria-label={t("管理分区", "Manage sections")}
          >
            {tabs.map((id) => (
              <button
                key={id}
                aria-pressed={tab === id}
                onClick={() => setTab(id)}
                className={`inline-flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm ${
                  tab === id
                    ? "bg-neon-cyan/10 font-medium text-neon-cyan"
                    : id === "danger"
                    ? "text-red-500/80 hover:bg-red-500/10"
                    : "text-text-secondary hover:bg-glass-bg hover:text-text-primary"
                }`}
              >
                {tabLabel[id]}
                {id === "access" && pending > 0 && (
                  <span className="rounded-full bg-neon-cyan/15 px-1.5 text-[11px] tabular-nums text-neon-cyan">
                    {pending}
                  </span>
                )}
              </button>
            ))}
          </nav>
        )}
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4 pb-[calc(1rem+env(safe-area-inset-bottom))] sm:px-5">
          {tab === "overview" && (
            <>
              <dl className="liquid-card space-y-2 rounded-2xl border border-glass-border p-4 text-sm">
                <div className="flex justify-between gap-3">
                  <dt className="text-text-secondary">{t("所有者", "Owner")}</dt>
                  <dd className="min-w-0 break-words text-right">
                    {isOwner ? t("我", "You") : agent.owner_name || "—"}
                  </dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-text-secondary">{t("默认回复方式", "Replies by default")}</dt>
                  <dd className="text-right">{replyModeLabel(agent.default_reply_mode, zh)}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-text-secondary">Agent ID</dt>
                  <dd className="min-w-0 select-all break-all text-right font-mono text-xs">{agent.agent_id}</dd>
                </div>
              </dl>
              <div className={`grid gap-2 ${isOwner ? "grid-cols-3" : "grid-cols-1"}`}>
                {isOwner && stat(agent.grant_count ?? 0, t("人可用", "with access"))}
                {stat(agent.room_count ?? 0, t("个房间", "rooms"))}
                {isOwner && stat(pending, t("待处理申请", "pending"), pending > 0)}
              </div>
              <div className="flex flex-wrap gap-2">
                {onChat && (
                  <button className={`${teamButton} border-neon-cyan/30 bg-neon-cyan/10 text-neon-cyan`} disabled={chatBusy} onClick={onChat}>
                    {chatBusy ? <Loader2 size={16} className="animate-spin" /> : <MessageCircle size={16} />}
                    {t("对话", "Chat")}
                  </button>
                )}
                {isOwner && pending > 0 && (
                  <button className={teamButton} onClick={() => setTab("access")}>
                    {t(`处理 ${pending} 个申请`, `Review ${pending} request${pending > 1 ? "s" : ""}`)}
                  </button>
                )}
              </div>
            </>
          )}
          {tab === "access" && isOwner && (
            <>
              <AccessRequestsInbox
                spaceId={spaceId}
                agentId={agent.agent_id}
                agentNames={{ [agent.agent_id]: agent.display_name }}
                onDecided={() => {
                  setGrantsVersion((v) => v + 1);
                  onChanged();
                }}
                hideWhenEmpty
              />
              <AgentAccessGrants
                key={grantsVersion}
                spaceId={spaceId}
                agentId={agent.agent_id}
                agentName={agent.display_name}
                users={users}
                userId={userId}
                onChanged={onChanged}
              />
            </>
          )}
          {tab === "rooms" && isOwner && (
            <AgentRoomsReply spaceId={spaceId} agentId={agent.agent_id} agentName={agent.display_name} users={users} />
          )}
          {tab === "danger" && canRemove && (
            <RemoveAgent spaceId={spaceId} agent={agent} onRemoved={onRemoved} />
          )}
        </div>
      </aside>
    </>
  );
}

function RemoveAgent({
  spaceId,
  agent,
  onRemoved,
}: {
  spaceId: string;
  agent: DirectoryAgent;
  onRemoved: () => void;
}) {
  const zh = useLanguage() === "zh";
  const t = (cn: string, en: string) => (zh ? cn : en);
  const confirm = useConfirm();
  const mounted = useRef(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  async function remove() {
    if (busy) return;
    const ok = await confirm({
      title: `${t("从组织移除", "Remove from organization")}: ${agent.display_name}`,
      message: t(
        "它会离开本组织的所有房间，成员的使用权限也会失效。个人 Agent 和其他组织身份保留。",
        "It leaves every room in this organization and members lose access to it. The personal Agent and other organization memberships remain.",
      ),
      confirmLabel: t("移除", "Remove"),
      tone: "danger",
    });
    if (!ok || !mounted.current) return;
    setBusy(true);
    setError(null);
    try {
      await teamSpacesApi.removeAgent(spaceId, agent.agent_id);
      if (mounted.current) onRemoved();
    } catch (cause) {
      if (mounted.current) setError(cause);
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  return (
    <section className="space-y-3 rounded-2xl border border-red-500/30 p-4">
      <h3 className="text-sm font-medium text-red-500">{t("从组织移除", "Remove from organization")}</h3>
      <p className="text-xs leading-5 text-text-secondary">
        {t(
          "移除后它不再出现在组织 Agent 列表里，需要重新添加才能回来。",
          "It disappears from the organization's Agents and has to be added again to come back.",
        )}
      </p>
      {error != null && (
        <p role="alert" className="text-sm text-red-500">
          {spaceError(error, zh)}
        </p>
      )}
      <button
        className={`${teamButton} border-red-500/40 text-red-500 hover:bg-red-500/10`}
        disabled={busy}
        onClick={() => void remove()}
      >
        {busy ? <Loader2 size={16} className="animate-spin" /> : <Trash2 size={16} />}
        {t("从组织移除", "Remove from organization")}
      </button>
    </section>
  );
}

function AgentRoomsReply({
  spaceId,
  agentId,
  agentName,
  users,
}: {
  spaceId: string;
  agentId: string;
  agentName: string;
  users: SpaceUser[];
}) {
  const zh = useLanguage() === "zh";
  const t = (cn: string, en: string) => (zh ? cn : en);
  const mounted = useRef(false);
  const [rooms, setRooms] = useState<AgentRoomReply[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const res = await teamAccessApi.agentRooms(spaceId, agentId, signal);
        if (mounted.current) {
          setRooms(res.rooms);
          setError(null);
        }
      } catch (cause) {
        if (mounted.current && !signal?.aborted) setError(cause);
      }
    },
    [spaceId, agentId],
  );
  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    void load(controller.signal);
    return () => {
      mounted.current = false;
      controller.abort();
    };
  }, [load]);

  const nameOf = (senderId: string) =>
    users.find((u) => u.human_id === senderId)?.display_name ?? senderId;
  async function removeRule(roomId: string, senderId: string) {
    const key = `${roomId}:${senderId}`;
    if (busy) return;
    setBusy(key);
    setError(null);
    try {
      await replyRulesApi.remove(agentId, senderId, roomId);
      // Safe to drop locally: DELETE is idempotent on the server.
      if (mounted.current)
        setRooms((prev) =>
          prev?.map((r) =>
            r.room_id === roomId
              ? { ...r, sender_rules: r.sender_rules.filter((s) => s.sender_id !== senderId) }
              : r,
          ) ?? prev,
        );
    } catch (cause) {
      if (mounted.current) setError(cause);
    } finally {
      if (mounted.current) setBusy(null);
    }
  }

  return (
    <div className="space-y-2">
      <p className="text-xs leading-5 text-text-secondary">
        {t(
          `${agentName} 在下面这些组织房间里。你可以分别设置它什么时候回复。`,
          `${agentName} is in these organization rooms. Choose when it replies in each.`,
        )}
      </p>
      {error != null && (
        <p role="alert" className="text-sm text-red-500">
          {spaceError(error, zh)}
        </p>
      )}
      {rooms == null ? (
        error == null && (
          <p role="status" className="flex items-center gap-2 py-4 text-xs text-text-secondary">
            <Loader2 size={14} className="animate-spin" />
            {t("正在加载房间…", "Loading rooms…")}
          </p>
        )
      ) : rooms.length === 0 ? (
        <p className="rounded-xl border border-dashed border-glass-border px-4 py-6 text-center text-sm text-text-secondary">
          {t(
            "它还没有加入任何组织房间。在房间的「成员与 Agent」里把它拉进来。",
            "It hasn't joined any organization room yet. Add it from a room's Members & Agents.",
          )}
        </p>
      ) : (
        <ul className="space-y-2">
          {rooms.map((room) => (
            <li key={room.room_id} className="liquid-card space-y-2 rounded-2xl border border-glass-border p-4">
              <p className="flex min-w-0 items-center gap-1.5 text-sm font-medium">
                <Hash size={14} className="shrink-0 text-text-secondary" />
                <span className="break-words">{room.name || room.room_id}</span>
              </p>
              <RoomReplyModeControl
                agentId={agentId}
                roomId={room.room_id}
                label={t(`${room.name} 的回复方式`, `Reply mode in ${room.name}`)}
                initial={{ mode: room.reply_mode, keywords: room.keywords, inherits: room.inherits_default }}
              />
              {room.sender_rules.length > 0 && (
                <ul className="flex flex-wrap gap-1.5" aria-label={t("按人设置的规则", "Per-person rules")}>
                  {room.sender_rules.map((rule) => (
                    <li
                      key={rule.sender_id}
                      className="inline-flex max-w-full items-center gap-1 rounded-lg border border-glass-border bg-glass-bg py-0.5 pl-2 pr-0.5 text-[11px]"
                    >
                      <span className="truncate">
                        {nameOf(rule.sender_id)}: {replyModeLabel(rule.attention_mode, zh)}
                      </span>
                      <button
                        className="rounded p-1 hover:bg-red-500/10 hover:text-red-500 disabled:opacity-50"
                        disabled={busy != null}
                        aria-label={t(
                          `删除对 ${nameOf(rule.sender_id)} 的规则`,
                          `Remove the rule for ${nameOf(rule.sender_id)}`,
                        )}
                        onClick={() => void removeRule(room.room_id, rule.sender_id)}
                      >
                        {busy === `${room.room_id}:${rule.sender_id}` ? (
                          <Loader2 size={11} className="animate-spin" />
                        ) : (
                          <X size={11} />
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
