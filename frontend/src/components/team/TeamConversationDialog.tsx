"use client";
import DashboardOverlayPortal from "@/components/dashboard/DashboardOverlayPortal";
import Alert from "@/components/ui/Alert";
import Button from "@/components/ui/Button";
import Checkbox from "@/components/ui/Checkbox";
import DialogShell from "@/components/ui/DialogShell";
import Field from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";
import Radio from "@/components/ui/Radio";

import Select from "@/components/ui/Select";
import { useLanguage } from "@/lib/i18n";
import { agentAddBlocker, newRoomBody, orgRoomsApi } from "@/lib/org-rooms";
import {
  spaceError,
  type SpaceAgent,
  type SpaceUser,
  type TeamSpace,
} from "@/lib/team-spaces";
import { Bot, Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

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
  const mounted = useRef(false);
  const locked = useRef(false);
  const [name, setName] = useState("");
  const [visibility, setVisibility] = useState<"organization" | "private">(
    kind === "dm" ? "private" : "organization",
  );
  const [selected, setSelected] = useState<string[]>([]);
  const [selectedAgents, setSelectedAgents] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const choices = users.filter(
    (u) => u.user_id !== userId && u.status === "active",
  );
  const agentChoices =
    kind === "room" ? agents.filter((a) => a.status === "active") : [];
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return (
    <DashboardOverlayPortal>
      <DialogShell
        size="lg"
        title={
          <>
            {kind === "room"
              ? t("创建房间", "Create room")
              : t("发起私聊", "New direct message")}
          </>
        }
        onClose={onClose}
        busy={busy}
        closeLabel={zh ? "关闭" : "Close"}
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
                      newRoomBody(name, visibility, selected, selectedAgents),
                    );
              if (mounted.current)
                onCreated({ room_id: created.room_id, kind });
            } catch (cause) {
              if (mounted.current) setError(cause);
            } finally {
              locked.current = false;
              if (mounted.current) setBusy(false);
            }
          }}
        >
          <div className="flex items-center justify-between gap-4"></div>
          {kind === "room" && (
            <>
              <Field label={<>{t("房间名称", "Room name")}</>}>
                <Input
                  autoFocus

                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                  maxLength={128}
                  disabled={busy}
                  placeholder={t("例如：产品讨论", "e.g. Product discussions")}
                />
              </Field>
              <Field
                label={
                  <>{t("谁可以查看和发言", "Who can read and send messages")}</>
                }
              >
                <Select
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
                </Select>
              </Field>
            </>
          )}
          {visibility === "private" && (
            <fieldset className="space-y-3" disabled={busy}>
              <legend className="mb-2 text-sm font-medium">
                {kind === "dm"
                  ? t("选择一位成员", "Choose a member")
                  : t(
                      "邀请成员（你将自动加入）",
                      "Invite members (you are included)",
                    )}
              </legend>
              <div className="max-h-52 space-y-1 overflow-y-auto">
                {choices.map((member) =>
                  kind === "dm" ? (
                    <label
                      key={member.id}
                      className="bc-touch-target flex items-center gap-3 p-3"
                    >
                      <Radio
                        name="member"
                        value={member.id}
                        checked={selected.includes(member.id)}
                        onChange={() => setSelected([member.id])}
                      />
                      <span className="break-words text-sm">
                        {member.display_name}
                      </span>
                    </label>
                  ) : (
                    <Checkbox
                      key={member.id}
                      name="member"
                      value={member.id}
                      checked={selected.includes(member.id)}
                      onCheckedChange={(checked) =>
                        setSelected(
                          checked
                            ? [...selected, member.id]
                            : selected.filter((id) => id !== member.id),
                        )
                      }
                      label={member.display_name}
                      className="w-full"
                    />
                  ),
                )}
                {!choices.length && (
                  <p className="text-sm text-text-secondary">
                    {t(
                      "还没有其他已加入的成员。先邀请同事加入组织。",
                      "No other active members yet. Invite a teammate first.",
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
                  const blocked = space
                    ? agentAddBlocker(space, agent, ownedAgentIds) != null
                    : false;
                  return (
                    <Checkbox
                      name="agent"
                      value={agent.agent_id}
                      disabled={blocked}
                      checked={selectedAgents.includes(agent.agent_id)}
                      onCheckedChange={(checked) =>
                        setSelectedAgents(
                          checked
                            ? [...selectedAgents, agent.agent_id]
                            : selectedAgents.filter(
                                (id) => id !== agent.agent_id,
                              ),
                        )
                      }
                      key={agent.agent_id}
                      label={
                        <>
                          <Bot size={15} className="shrink-0 text-neon-cyan" />
                          <span className="min-w-0 flex-1">
                            <span className="block break-words text-sm">
                              {agent.display_name}
                            </span>
                            {blocked && (
                              <span className="block text-xs text-text-secondary">
                                {t(
                                  "仅 Agent 所有者或组织管理员可添加",
                                  "Only its owner or an organization admin can add it",
                                )}
                              </span>
                            )}
                          </span>
                        </>
                      }
                    />
                  );
                })}
              </div>
            </fieldset>
          )}
          <p className="text-xs leading-5 text-text-secondary">
            {visibility === "organization"
              ? t(
                  "组织成员都能在房间列表里看到并加入，加入后可查看全部历史。",
                  "Everyone in the organization can find and join this room, then read its full history.",
                )
              : t(
                  "仅所选成员可以访问。退出组织后将失去访问权限。",
                  "Only selected members can access this conversation. Leaving the organization revokes access.",
                )}
          </p>
          {error != null && (
            <Alert tone="danger">{spaceError(error, zh)}</Alert>
          )}
          <div className="flex justify-end gap-3">
            <Button
              variant="secondary"
              type="button"
              disabled={busy}
              onClick={onClose}
            >
              {t("取消", "Cancel")}
            </Button>
            <Button
              type="submit"
              variant="primary"

              disabled={
                busy || (kind === "room" ? !name.trim() : selected.length !== 1)
              }
            >
              {busy && <Loader2 size={16} className="animate-spin" />}
              {kind === "room"
                ? t("创建房间", "Create room")
                : t("开始对话", "Start conversation")}
            </Button>
          </div>
        </form>
      </DialogShell>
    </DashboardOverlayPortal>
  );
}
