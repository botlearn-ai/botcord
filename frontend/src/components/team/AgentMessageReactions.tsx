"use client";
/**
 * [INPUT]: Member-visible reply activity projections and the room's animation owner
 * [OUTPUT]: Avatar reactions with a live list/detail inspector
 * [POS]: Team message composition; no network mutations
 * [PROTOCOL]: Prefer response_state; never treat presence or legacy no_reply as a response decision
 */
import type { ReactNode } from "react";
import { useContext, useState, createContext } from "react";
import { ArrowLeft } from "lucide-react";
import AgentReactionStrip from "@/components/ui/AgentReactionStrip";
import AgentResponseAvatar from "@/components/ui/AgentResponseAvatar";
import Button from "@/components/ui/Button";
import ReactionPanel from "@/components/ui/ReactionPanel";
import { withDashboardOverlayPortal } from "@/components/dashboard/DashboardOverlayPortal";
import { useLanguage } from "@/lib/i18n";
import { responseLabels, responseReason, responseState, sortedResponses } from "@/lib/message-response-activity";
import type { RoomReplyActivity } from "@/lib/types";

export const ReactionMotionContext = createContext<string | null | undefined>(undefined);
const Panel = withDashboardOverlayPortal(ReactionPanel);
export default function AgentMessageReactions({ activity, messageId, actions, align }: { activity: RoomReplyActivity[]; messageId: string; actions?: ReactNode; align?: "start" | "end" }) {
  const zh = useLanguage() === "zh";
  const motion = useContext(ReactionMotionContext);
  const [selection, setSelection] = useState<{ id: string | null; anchor: HTMLElement } | null>(null);
  const ordered = sortedResponses(activity);
  const activeId = motion === undefined ? ordered.find((a) => ["processing", "replying"].includes(responseState(a)))?.agent_id
    : ordered.find((a) => motion === `${messageId}:${a.agent_id}`)?.agent_id;
  const title = zh ? `${activity.length} 个 Agent 的处理状态` : `Response status · ${activity.length} Agents`;
  const selected = activity.find((a) => a.agent_id === selection?.id);
  const label = (a: RoomReplyActivity) => responseLabels[responseState(a)][zh ? 0 : 1];
  const reason = selected && responseReason(selected.reason, zh);
  const updated = selected?.updated_at ? new Date(selected.updated_at) : null;
  if (!ordered.length) return null;
  return <>
    <AgentReactionStrip align={align} label={title} moreLabel={(n) => zh ? `查看另外 ${n} 个 Agent` : `View ${n} more Agents`}
      items={ordered.map((a) => ({ id: a.agent_id, name: a.agent_name, src: a.avatar_url, state: responseState(a),
        label: `${a.agent_name} · ${label(a)}`, animate: a.agent_id === activeId && !selection }))}
      onSelect={(id, anchor) => setSelection({ id, anchor })} />
    {selection && <Panel anchor={selection.anchor} title={title} closeLabel={zh ? "关闭" : "Close"} onClose={() => setSelection(null)}>
      {selected ? <div className="space-y-4">
        <Button variant="inline" size="sm" onClick={() => setSelection({ ...selection, id: null })}><ArrowLeft size={16} strokeWidth={1.75} />{zh ? "全部 Agent" : "All Agents"}</Button>
        <div className="flex items-center gap-3"><AgentResponseAvatar id={selected.agent_id} name={selected.agent_name} src={selected.avatar_url} state={responseState(selected)} />
          <div className="min-w-0"><p className="break-words text-sm font-semibold">{selected.agent_name}</p><p className="text-sm text-text-secondary">{label(selected)}</p></div></div>
        {responseState(selected) === "unknown" && <p className="text-sm text-text-secondary">{zh ? "缺少足够的处理记录，不代表被忽略。" : "There are not enough processing records. This does not mean the message was ignored."}</p>}
        {reason && <p className="text-sm text-text-secondary">{reason}</p>}
        <p className="text-xs text-text-secondary">{selected.derived ? (zh ? "来源：系统推断" : "Source: system inference") : selected.basis === "legacy" || responseState(selected) === "unknown" ? (zh ? "来源：历史记录" : "Source: historical records") : (zh ? "来源：Agent 上报" : "Source: Agent report")}</p>
        {updated && Number.isFinite(updated.getTime()) && <p className="text-xs text-text-secondary">{zh ? "最后上报：" : "Last reported: "}<time dateTime={selected.updated_at!}>{updated.toLocaleString(zh ? "zh-CN" : "en-US")}</time></p>}
        <p className="text-xs text-text-secondary">{zh ? "这是对本条消息的处理状态，与 Agent 是否在线无关。" : "This status applies to this message, independently of whether the Agent is online."}</p>
      </div> : <div className="space-y-1">{ordered.map((a) => <Button key={a.agent_id} variant="row" onClick={() => setSelection({ ...selection, id: a.agent_id })}>
        <span className="flex items-center gap-3"><AgentResponseAvatar id={a.agent_id} name={a.agent_name} src={a.avatar_url} state={responseState(a)} /><span className="min-w-0"><span className="block break-words text-sm">{a.agent_name}</span><span className="block text-xs text-text-secondary">{label(a)}</span></span></span>
      </Button>)}</div>}
      {actions && <div className="mt-4 space-y-2 border-t border-border pt-3 text-xs text-text-secondary">{actions}</div>}
    </Panel>}
  </>;
}
