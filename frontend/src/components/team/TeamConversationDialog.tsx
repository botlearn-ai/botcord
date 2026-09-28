"use client";

import { useEffect, useRef, useState } from "react";
import { Bot, Loader2, X } from "lucide-react";
import { useLanguage } from "@/lib/i18n";
import {
  spaceError,
  type SpaceAgent,
  type SpaceUser,
  type TeamSpace,
} from "@/lib/team-spaces";
import { agentAddBlocker, newRoomBody, orgRoomsApi } from "@/lib/org-rooms";

export const teamInput =
  "w-full rounded-xl border border-glass-border bg-deep-black px-3 py-2.5 text-sm outline-none focus:border-neon-cyan disabled:opacity-50";
export const teamButton =
  "inline-flex items-center justify-center gap-2 rounded-xl border border-glass-border px-4 py-2.5 text-sm transition-colors hover:bg-neon-cyan/10 focus-visible:outline-2 focus-visible:outline-neon-cyan disabled:opacity-50 disabled:cursor-not-allowed";

export default function TeamConversationDialog({
  spaceId,
  space,
  kind,
  users,
  agents = [],
  ownedAgentIds = [],
  userId,
  onClose,
  onCreated,
}: {
  spaceId: string;
  space?: TeamSpace;
  kind: "room" | "dm";
  users: SpaceUser[];
  /** Organization Agents that may be pulled into a new room. */
  agents?: SpaceAgent[];
  ownedAgentIds?: string[];
  userId: string;
  onClose: () => void;
  onCreated: (room: { room_id: string; kind: "room" | "dm" }) => void;
}) {
  const zh = useLanguage() === "zh";
  const t = (cn: string, en: string) => (zh ? cn : en);
  const dialog = useRef<HTMLDialogElement>(null);
  const mounted = useRef(false);
  const locked = useRef(false);
  const [name, setName] = useState("");
  const [visibility, setVisibility] = useState<"organization" | "private">(
    kind === "dm" ? "private" : "organization"
  );
  const [selected, setSelected] = useState<string[]>([]);
  const [selectedAgents, setSelectedAgents] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const choices = users.filter(
    (u) => u.user_id !== userId && u.status === "active"
  );
  const agentChoices = kind === "room" ? agents.filter((a) => a.status === "active") : [];
  useEffect(() => {
    mounted.current = true;
    dialog.current?.showModal();
    return () => {
      mounted.current = false;
    };
  }, []);
  return (
    <dialog
      ref={dialog}
      onCancel={onClose}
      aria-labelledby="team-create-title"
      className="m-auto max-h-[85dvh] w-[calc(100%-2rem)] max-w-lg overflow-y-auto rounded-2xl border border-glass-border bg-deep-black p-6 text-text-primary shadow-xl backdrop:bg-black/50"
    >
      <form
        className="space-y-5"
        onSubmit={async (event) => {
          event.preventDefault();
          if (locked.current) return;
          locked.current = true;
          setBusy(true);
          setError(null);
          try {
            const created =
              kind === "dm"
                ? await orgRoomsApi.openDm(spaceId, selected[0])
                : await orgRoomsApi.create(
                    spaceId,
                    newRoomBody(name, visibility, selected, selectedAgents)
                  );
            if (mounted.current) onCreated({ room_id: created.room_id, kind });
          } catch (cause) {
            if (mounted.current) setError(cause);
          } finally {
            locked.current = false;
            if (mounted.current) setBusy(false);
          }
        }}
      >
        <div className="flex items-center justify-between gap-4">
          <h2 id="team-create-title" className="text-lg font-semibold">
            {kind === "room"
              ? t("创建房间", "Create room")
              : t("发起私聊", "New direct message")}
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
        {kind === "room" && (
          <>
            <label className="block space-y-2 text-sm">
              <span>{t("房间名称", "Room name")}</span>
              <input
                autoFocus
                className={teamInput}
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                maxLength={128}
                disabled={busy}
                placeholder={t("例如：产品讨论", "e.g. Product discussions")}
              />
            </label>
            <label className="block space-y-2 text-sm">
              <span>
                {t("谁可以查看和发言", "Who can read and send messages")}
              </span>
              <select
                className={teamInput}
                value={visibility}
                disabled={busy}
                onChange={(e) =>
                  setVisibility(e.target.value as typeof visibility)
                }
              >
                <option value="organization">
                  {t("组织全体成员", "Everyone in this organization")}
                </option>
                <option value="private">
                  {t("仅指定成员", "Selected members only")}
                </option>
              </select>
            </label>
          </>
        )}
        {visibility === "private" && (
          <fieldset className="space-y-3" disabled={busy}>
            <legend className="mb-2 text-sm font-medium">
              {kind === "dm"
                ? t("选择一位成员", "Choose a member")
                : t(
                    "邀请成员（你将自动加入）",
                    "Invite members (you are included)"
                  )}
            </legend>
            <div className="max-h-52 space-y-1 overflow-y-auto">
              {choices.map((member) => (
                <label
                  key={member.id}
                  className="flex cursor-pointer items-center gap-3 rounded-lg p-3 hover:bg-glass-bg"
                >
                  <input
                    type={kind === "dm" ? "radio" : "checkbox"}
                    name="member"
                    value={member.id}
                    checked={selected.includes(member.id)}
                    onChange={(e) =>
                      setSelected(
                        kind === "dm"
                          ? [member.id]
                          : e.target.checked
                          ? [...selected, member.id]
                          : selected.filter((id) => id !== member.id)
                      )
                    }
                  />
                  <span className="break-words text-sm">
                    {member.display_name}
                  </span>
                </label>
              ))}
              {!choices.length && (
                <p className="text-sm text-text-secondary">
                  {t(
                    "还没有其他已加入的成员。先邀请同事加入组织。",
                    "No other active members yet. Invite a teammate first."
                  )}
                </p>
              )}
            </div>
          </fieldset>
        )}
        {agentChoices.length > 0 && (
          <fieldset className="space-y-2" disabled={busy}>
            <legend className="mb-2 text-sm font-medium">
              {t("拉 Agent 进房间（可选）", "Add Agents (optional)")}
            </legend>
            <div className="max-h-44 space-y-1 overflow-y-auto">
              {agentChoices.map((agent) => {
                const blocked = space ? agentAddBlocker(space, agent, ownedAgentIds) != null : false;
                return (
                  <label
                    key={agent.agent_id}
                    className={`flex items-center gap-3 rounded-lg p-3 ${
                      blocked ? "opacity-60" : "cursor-pointer hover:bg-glass-bg"
                    }`}
                  >
                    <input
                      type="checkbox"
                      name="agent"
                      value={agent.agent_id}
                      disabled={blocked}
                      checked={selectedAgents.includes(agent.agent_id)}
                      onChange={(e) =>
                        setSelectedAgents(
                          e.target.checked
                            ? [...selectedAgents, agent.agent_id]
                            : selectedAgents.filter((id) => id !== agent.agent_id)
                        )
                      }
                    />
                    <Bot size={15} className="shrink-0 text-neon-cyan" />
                    <span className="min-w-0 flex-1">
                      <span className="block break-words text-sm">{agent.display_name}</span>
                      {blocked && (
                        <span className="block text-[11px] text-text-secondary">
                          {t("仅 Agent 所有者或组织管理员可添加", "Only its owner or an organization admin can add it")}
                        </span>
                      )}
                    </span>
                  </label>
                );
              })}
            </div>
          </fieldset>
        )}
        <p className="text-xs leading-5 text-text-secondary">
          {visibility === "organization"
            ? t(
                "组织成员都能在房间列表里看到并加入，加入后可查看全部历史。",
                "Everyone in the organization can find and join this room, then read its full history."
              )
            : t(
                "仅所选成员可以访问。退出组织后将失去访问权限。",
                "Only selected members can access this conversation. Leaving the organization revokes access."
              )}
        </p>
        {error != null && (
          <p role="alert" className="text-sm text-red-500">
            {spaceError(error, zh)}
          </p>
        )}
        <div className="flex justify-end gap-3">
          <button type="button" className={teamButton} onClick={onClose}>
            {t("取消", "Cancel")}
          </button>
          <button
            className={`${teamButton} bg-neon-cyan/10 text-neon-cyan`}
            disabled={
              busy || (kind === "room" ? !name.trim() : selected.length !== 1)
            }
          >
            {busy && <Loader2 size={16} className="animate-spin" />}
            {kind === "room"
              ? t("创建房间", "Create room")
              : t("开始对话", "Start conversation")}
          </button>
        </div>
      </form>
    </dialog>
  );
}
