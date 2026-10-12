"use client";
import DashboardOverlayPortal from "@/components/dashboard/DashboardOverlayPortal";
import Alert from "@/components/ui/Alert";
import { BotCordLoader } from "@/components/ui/BotCordLoader";
import Button from "@/components/ui/Button";
import Card from "@/components/ui/Card";
import EmptyState from "@/components/ui/EmptyState";
import IconButton from "@/components/ui/IconButton";

import Badge from "@/components/ui/Badge";
import DrawerShell from "@/components/ui/DrawerShell";
import MetricCard from "@/components/ui/MetricCard";
import Tabs from "@/components/ui/Tabs";
import { useLanguage } from "@/lib/i18n";
import {
  replyModeLabel,
  replyRulesApi,
  teamAccessApi,
  type AgentRoomReply,
  type DirectoryAgent,
} from "@/lib/team-access";
import { spaceError, teamSpacesApi, type SpaceUser } from "@/lib/team-spaces";
import { useConfirm } from "@/store/useConfirmStore";
import { Hash, Loader2, MessageCircle, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import AccessRequestsInbox from "./AccessRequestsInbox";
import AgentAccessGrants from "./AgentAccessGrants";
import { AgentIdentity } from "./AgentIdentity";
import RoomReplyModeControl from "./RoomReplyModeControl";

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
  const [tab, setTab] = useState<ManageTab>(
    tabs.includes(initialTab) ? initialTab : "overview",
  );
  const [grantsVersion, setGrantsVersion] = useState(0);
  const [removing, setRemoving] = useState(false);
  const tabLabel: Record<ManageTab, string> = {
    overview: t("概览", "Overview"),
    access: t("谁可以用", "Who can use"),
    rooms: t("房间与回复", "Rooms & replies"),
    danger: t("危险操作", "Danger zone"),
  };
  const stat = (value: number | string, label: string, accent = false) => (
    <MetricCard value={value} label={label} accent={accent} />
  );

  return (
    <DashboardOverlayPortal>
      <DrawerShell
        size="lg"
        busy={removing}
        title={
          <AgentIdentity agent={agent} size={44} className="min-w-0 flex-1" />
        }
        onClose={onClose}
        closeLabel={t("关闭", "Close")}
      >
        {tabs.length > 1 && (
          <Tabs
            value={tab}
            onValueChange={(value) => setTab(value as ManageTab)}
            ariaLabel={t("管理分区", "Manage sections")}
            items={tabs.map((id) => ({
              value: id,
              label: tabLabel[id],
              badge:
                id === "access" && pending > 0 ? (
                  <Badge tone="accent">{pending}</Badge>
                ) : undefined,
            }))}
          />
        )}
        <div className="mt-4 space-y-4">
          {tab === "overview" && (
            <>
              <Card as="dl" className="space-y-2">
                <div className="flex justify-between gap-3">
                  <dt className="text-text-secondary">
                    {t("所有者", "Owner")}
                  </dt>
                  <dd className="min-w-0 break-words text-right">
                    {isOwner ? t("我", "You") : agent.owner_name || "—"}
                  </dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-text-secondary">
                    {t("默认回复方式", "Replies by default")}
                  </dt>
                  <dd className="text-right">
                    {replyModeLabel(agent.default_reply_mode, zh)}
                  </dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-text-secondary">Agent ID</dt>
                  <dd className="min-w-0 select-all break-all text-right font-mono text-xs">
                    {agent.agent_id}
                  </dd>
                </div>
              </Card>
              <div
                className={`grid gap-2 ${isOwner ? "grid-cols-3" : "grid-cols-1"}`}
              >
                {isOwner &&
                  stat(agent.grant_count ?? 0, t("人可用", "with access"))}
                {stat(agent.room_count ?? 0, t("个房间", "rooms"))}
                {isOwner &&
                  stat(pending, t("待处理申请", "pending"), pending > 0)}
              </div>
              <div className="flex flex-wrap gap-2">
                {onChat && (
                  <Button
                    variant="primary"
                    disabled={chatBusy}
                    onClick={onChat}
                  >
                    {chatBusy ? (
                      <Loader2 size={16} className="animate-spin" />
                    ) : (
                      <MessageCircle size={16} />
                    )}
                    {t("对话", "Chat")}
                  </Button>
                )}
                {isOwner && pending > 0 && (
                  <Button variant="secondary" onClick={() => setTab("access")}>
                    {t(
                      `处理 ${pending} 个申请`,
                      `Review ${pending} request${pending > 1 ? "s" : ""}`,
                    )}
                  </Button>
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
            <AgentRoomsReply
              spaceId={spaceId}
              agentId={agent.agent_id}
              agentName={agent.display_name}
              users={users}
            />
          )}
          {tab === "danger" && canRemove && (
            <RemoveAgent
              spaceId={spaceId}
              agent={agent}
              onRemoved={onRemoved}
              onBusyChange={setRemoving}
            />
          )}
        </div>
      </DrawerShell>
    </DashboardOverlayPortal>
  );
}

function RemoveAgent({
  spaceId,
  agent,
  onRemoved,
  onBusyChange,
}: {
  spaceId: string;
  agent: DirectoryAgent;
  onRemoved: () => void;
  onBusyChange: (busy: boolean) => void;
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
    onBusyChange(true);
    setError(null);
    try {
      await teamSpacesApi.removeAgent(spaceId, agent.agent_id);
      if (mounted.current) onRemoved();
    } catch (cause) {
      if (mounted.current) setError(cause);
    } finally {
      if (mounted.current) {
        setBusy(false);
        onBusyChange(false);
      }
    }
  }

  return (
    <Card as="section" className="space-y-3">
      <h3 className="text-sm font-medium text-danger">
        {t("从组织移除", "Remove from organization")}
      </h3>
      <p className="text-xs leading-5 text-text-secondary">
        {t(
          "移除后它不再出现在组织 Agent 列表里，需要重新添加才能回来。",
          "It disappears from the organization's Agents and has to be added again to come back.",
        )}
      </p>
      {error != null && <Alert tone="danger">{spaceError(error, zh)}</Alert>}
      <Button
        variant="danger"

        disabled={busy}
        onClick={() => void remove()}
      >
        {busy ? (
          <Loader2 size={16} className="animate-spin" />
        ) : (
          <Trash2 size={16} />
        )}
        {t("从组织移除", "Remove from organization")}
      </Button>
    </Card>
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
        setRooms(
          (prev) =>
            prev?.map((r) =>
              r.room_id === roomId
                ? {
                    ...r,
                    sender_rules: r.sender_rules.filter(
                      (s) => s.sender_id !== senderId,
                    ),
                  }
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
      {error != null && <Alert tone="danger">{spaceError(error, zh)}</Alert>}
      {rooms == null ? (
        error == null && (
          <BotCordLoader
            size="sm"
            className="w-full py-6"
            label={t("正在加载房间…", "Loading rooms…")}
          />
        )
      ) : rooms.length === 0 ? (
        <EmptyState
          compact
          title={
            <>
              {t(
                "它还没有加入任何组织房间。在房间的「成员与 Agent」里把它拉进来。",
                "It hasn't joined any organization room yet. Add it from a room's Members & Agents.",
              )}
            </>
          }
        />
      ) : (
        <ul className="space-y-2">
          {rooms.map((room) => (
            <Card as="li" key={room.room_id} className="space-y-2">
              <p className="flex min-w-0 items-center gap-1.5 text-sm font-medium">
                <Hash size={14} className="shrink-0 text-text-secondary" />
                <span className="break-words">{room.name || room.room_id}</span>
              </p>
              <RoomReplyModeControl
                agentId={agentId}
                roomId={room.room_id}
                label={t(
                  `${room.name} 的回复方式`,
                  `Reply mode in ${room.name}`,
                )}
                initial={{
                  mode: room.reply_mode,
                  keywords: room.keywords,
                  inherits: room.inherits_default,
                }}
              />
              {room.sender_rules.length > 0 && (
                <ul
                  className="flex flex-wrap gap-1.5"
                  aria-label={t("按人设置的规则", "Per-person rules")}
                >
                  {room.sender_rules.map((rule) => (
                    <li
                      key={rule.sender_id}
                      className="inline-flex max-w-full items-center gap-1 rounded-lg border border-glass-border bg-glass-bg py-0.5 pl-2 pr-0.5 text-xs"
                    >
                      <span className="truncate">
                        {nameOf(rule.sender_id)}:{" "}
                        {replyModeLabel(rule.attention_mode, zh)}
                      </span>
                      <IconButton
                        danger
                        size="sm"

                        disabled={busy != null}
                        label={t(
                          `删除对 ${nameOf(rule.sender_id)} 的规则`,
                          `Remove the rule for ${nameOf(rule.sender_id)}`,
                        )}
                        onClick={() =>
                          void removeRule(room.room_id, rule.sender_id)
                        }
                      >
                        {busy === `${room.room_id}:${rule.sender_id}` ? (
                          <Loader2 size={11} className="animate-spin" />
                        ) : (
                          <X size={11} />
                        )}
                      </IconButton>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          ))}
        </ul>
      )}
    </div>
  );
}
