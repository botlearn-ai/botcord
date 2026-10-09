"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Hash, Loader2, X } from "lucide-react";
import { useLanguage } from "@/lib/i18n";
import { spaceError, type SpaceUser } from "@/lib/team-spaces";
import { replyModeLabel, replyRulesApi, teamAccessApi, type AgentRoomReply } from "@/lib/team-access";
import AgentAccessGrants from "./AgentAccessGrants";
import AccessRequestsInbox from "./AccessRequestsInbox";
import RoomReplyModeControl from "./RoomReplyModeControl";

/**
 * Owner panel for one organization Agent: pending requests, who may use it
 * (grants), and the organization rooms it is in with its reply mode and
 * per-sender rules there.
 */
export default function AgentAccessPanel({
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
  const [grantsVersion, setGrantsVersion] = useState(0);
  return (
    <div className="w-full space-y-4">
      <AccessRequestsInbox
        spaceId={spaceId}
        agentId={agentId}
        agentNames={{ [agentId]: agentName }}
        onDecided={() => setGrantsVersion((v) => v + 1)}
        hideWhenEmpty
      />
      <AgentAccessGrants
        key={grantsVersion}
        spaceId={spaceId}
        agentId={agentId}
        agentName={agentName}
        users={users}
        userId={userId}
      />
      <AgentRoomsReply spaceId={spaceId} agentId={agentId} agentName={agentName} users={users} />
    </div>
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
    <div className="space-y-2 rounded-xl border border-glass-border bg-deep-black/40 p-4">
      <h3 className="text-sm font-medium">{t("所在房间与回复方式", "Rooms and when it replies")}</h3>
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
          <p role="status" className="flex items-center gap-2 text-xs text-text-secondary">
            <Loader2 size={14} className="animate-spin" />
            {t("正在加载房间…", "Loading rooms…")}
          </p>
        )
      ) : rooms.length === 0 ? (
        <p className="text-xs text-text-secondary">
          {t("它还没有加入任何组织房间。", "It hasn't joined any organization room yet.")}
        </p>
      ) : (
        <ul className="divide-y divide-glass-border">
          {rooms.map((room) => (
            <li key={room.room_id} className="space-y-2 py-3">
              <p className="flex min-w-0 items-center gap-1.5 text-sm">
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
