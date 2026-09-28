"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Bot, Loader2, Plus, User, X } from "lucide-react";
import { useLanguage } from "@/lib/i18n";
import { spaceError, type SpaceMembers, type TeamSpace } from "@/lib/team-spaces";
import {
  agentAddBlocker,
  canRemoveParticipant,
  orgRoomsApi,
  type OrgParticipant,
  type OrgRoom,
} from "@/lib/org-rooms";

const row = "flex items-center gap-3 rounded-xl px-3 py-2.5";
const smallButton =
  "inline-flex shrink-0 items-center gap-1 rounded-lg border border-glass-border px-2.5 py-1.5 text-xs transition-colors hover:bg-neon-cyan/10 disabled:cursor-not-allowed disabled:opacity-50";

/** 「成员与 Agent」: who is in an organization room, add org members / Agents, remove. */
export default function TeamRoomMembersDialog({
  spaceId,
  space,
  room,
  members,
  viewerId,
  ownedAgentIds,
  onClose,
  onChanged,
}: {
  spaceId: string;
  space: TeamSpace;
  room: OrgRoom;
  members: SpaceMembers;
  viewerId: string;
  ownedAgentIds: string[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const zh = useLanguage() === "zh";
  const t = (cn: string, en: string) => (zh ? cn : en);
  const dialog = useRef<HTMLDialogElement>(null);
  const mounted = useRef(false);
  const [participants, setParticipants] = useState<OrgParticipant[]>(room.participants);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [adding, setAdding] = useState<"agent" | "member" | null>(null);
  const isDm = room.space_kind === "dm";
  const myRole = participants.find((p) => p.id === viewerId)?.role ?? room.my_role;

  const load = useCallback(async () => {
    try {
      const res = await orgRoomsApi.participants(spaceId, room.room_id);
      if (mounted.current) setParticipants(res.participants);
    } catch (cause) {
      if (mounted.current) setError(cause);
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [spaceId, room.room_id]);

  useEffect(() => {
    mounted.current = true;
    dialog.current?.showModal?.();
    void load();
    return () => {
      mounted.current = false;
    };
  }, [load]);

  const run = async (key: string, action: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(key);
    setError(null);
    try {
      await action();
      await load();
      onChanged();
    } catch (cause) {
      if (mounted.current) setError(cause);
    } finally {
      if (mounted.current) setBusy(null);
    }
  };

  const inRoom = new Set(participants.map((p) => p.id));
  const humans = participants.filter((p) => p.kind === "human");
  const agents = participants.filter((p) => p.kind === "agent");
  const addableAgents = members.agents.filter((a) => a.status === "active" && !inRoom.has(a.agent_id));
  const addableUsers = members.users.filter((u) => u.status === "active" && !inRoom.has(u.human_id));

  const participantRow = (p: OrgParticipant) => {
    const removable = canRemoveParticipant(p, { space, viewerId, myRole, ownedAgentIds, isDm });
    return (
      <li key={p.id} className={row}>
        <span
          className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${
            p.kind === "agent" ? "bg-neon-cyan/10 text-neon-cyan" : "bg-glass-bg text-text-secondary"
          }`}
        >
          {p.kind === "agent" ? <Bot size={16} /> : <User size={16} />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="truncate text-sm">{p.display_name}</span>
            {p.kind === "agent" && (
              <span className="shrink-0 rounded bg-neon-cyan/10 px-1.5 text-[10px] font-medium text-neon-cyan">Agent</span>
            )}
            {p.id === viewerId && (
              <span className="shrink-0 text-[11px] text-text-secondary">{t("（我）", "(you)")}</span>
            )}
          </span>
          {p.role === "owner" || p.role === "admin" ? (
            <span className="text-[11px] text-text-secondary">
              {p.role === "owner" ? t("房间所有者", "Room owner") : t("房间管理员", "Room admin")}
            </span>
          ) : null}
        </span>
        {removable && (
          <button
            className={`${smallButton} text-red-400`}
            disabled={busy != null}
            aria-label={t(`移除 ${p.display_name}`, `Remove ${p.display_name}`)}
            onClick={() => void run(`rm:${p.id}`, () => orgRoomsApi.removeParticipant(spaceId, room.room_id, p.id))}
          >
            {busy === `rm:${p.id}` ? <Loader2 size={13} className="animate-spin" /> : null}
            {t("移除", "Remove")}
          </button>
        )}
      </li>
    );
  };

  return (
    <dialog
      ref={dialog}
      onCancel={onClose}
      aria-labelledby="team-room-members-title"
      className="m-auto max-h-[85dvh] w-[calc(100%-1.5rem)] max-w-lg overflow-y-auto rounded-2xl border border-glass-border bg-deep-black p-5 text-text-primary shadow-xl backdrop:bg-black/50"
    >
      <div className="mb-4 flex items-center justify-between gap-4">
        <h2 id="team-room-members-title" className="text-lg font-semibold">
          {t("成员与 Agent", "Members & Agents")}
        </h2>
        <button
          type="button"
          className="rounded-lg p-2 hover:bg-glass-bg"
          aria-label={t("关闭", "Close")}
          onClick={onClose}
        >
          <X size={18} />
        </button>
      </div>
      {error != null && (
        <p role="alert" className="mb-3 rounded-xl border border-red-500/30 p-3 text-sm text-red-500">
          {spaceError(error, zh)}
        </p>
      )}
      {loading && !participants.length ? (
        <p role="status" className="flex items-center justify-center gap-2 py-6 text-xs text-text-secondary">
          <Loader2 size={16} className="animate-spin" />
          {t("正在加载…", "Loading…")}
        </p>
      ) : (
        <div className="space-y-5">
          <section>
            <div className="mb-1 flex items-center justify-between">
              <h3 className="text-xs font-medium text-text-secondary">
                {t("成员", "Members")} · {humans.length}
              </h3>
              {!isDm && (
                <button
                  className={smallButton}
                  aria-expanded={adding === "member"}
                  onClick={() => setAdding(adding === "member" ? null : "member")}
                >
                  <Plus size={13} />
                  {t("添加成员", "Add member")}
                </button>
              )}
            </div>
            {adding === "member" && (
              <ul className="mb-2 rounded-xl border border-glass-border p-1" aria-label={t("可添加的成员", "Members to add")}>
                {addableUsers.map((u) => (
                  <li key={u.id} className={row}>
                    <span className="min-w-0 flex-1 truncate text-sm">{u.display_name}</span>
                    <button
                      className={`${smallButton} text-neon-cyan`}
                      disabled={busy != null}
                      onClick={() => void run(`mb:${u.id}`, () => orgRoomsApi.addMembers(spaceId, room.room_id, [u.id]))}
                    >
                      {busy === `mb:${u.id}` ? <Loader2 size={13} className="animate-spin" /> : null}
                      {t("添加", "Add")}
                    </button>
                  </li>
                ))}
                {!addableUsers.length && (
                  <li className="px-3 py-2 text-xs text-text-secondary">
                    {t("组织成员都已在房间里。", "Everyone in the organization is already here.")}
                  </li>
                )}
              </ul>
            )}
            <ul>{humans.map(participantRow)}</ul>
          </section>
          <section>
            <div className="mb-1 flex items-center justify-between">
              <h3 className="text-xs font-medium text-text-secondary">
                Agent · {agents.length}
              </h3>
              {!isDm && (
                <button
                  className={smallButton}
                  aria-expanded={adding === "agent"}
                  onClick={() => setAdding(adding === "agent" ? null : "agent")}
                >
                  <Plus size={13} />
                  {t("添加 Agent", "Add Agent")}
                </button>
              )}
            </div>
            {isDm ? (
              <p className="px-3 py-2 text-xs text-text-secondary">
                {t("私聊不能添加 Agent，可以在房间里添加。", "Agents can't be added to direct messages; add them to a room.")}
              </p>
            ) : (
              adding === "agent" && (
                <ul className="mb-2 rounded-xl border border-glass-border p-1" aria-label={t("可添加的 Agent", "Agents to add")}>
                  {addableAgents.map((a) => {
                    const blocker = agentAddBlocker(space, a, ownedAgentIds);
                    return (
                      <li key={a.agent_id} className={row}>
                        <Bot size={16} className="shrink-0 text-neon-cyan" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm">{a.display_name}</span>
                          {blocker && (
                            <span className="block text-[11px] leading-4 text-text-secondary">
                              {t("仅 Agent 所有者或组织管理员可添加", "Only its owner or an organization admin can add it")}
                            </span>
                          )}
                        </span>
                        <button
                          className={`${smallButton} text-neon-cyan`}
                          disabled={busy != null || blocker != null}
                          onClick={() => void run(`ag:${a.agent_id}`, () => orgRoomsApi.addAgent(spaceId, room.room_id, a.agent_id))}
                        >
                          {busy === `ag:${a.agent_id}` ? <Loader2 size={13} className="animate-spin" /> : null}
                          {t("添加", "Add")}
                        </button>
                      </li>
                    );
                  })}
                  {!addableAgents.length && (
                    <li className="px-3 py-2 text-xs text-text-secondary">
                      {members.agents.some((a) => a.status === "active")
                        ? t("组织内的 Agent 都已在房间里。", "All organization Agents are already here.")
                        : t("组织里还没有 Agent，先在「Agent」页添加。", "No Agents in this organization yet. Add one on the Agents page.")}
                    </li>
                  )}
                </ul>
              )
            )}
            {!isDm && !agents.length && adding !== "agent" && (
              <p className="px-3 py-2 text-xs text-text-secondary">
                {t("还没有 Agent 在这个房间。", "No Agents in this room yet.")}
              </p>
            )}
            <ul>{agents.map(participantRow)}</ul>
          </section>
        </div>
      )}
    </dialog>
  );
}
