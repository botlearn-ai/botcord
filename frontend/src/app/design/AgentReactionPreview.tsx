"use client";
/**
 * [INPUT]: Production message feedback, local response fixtures, shared select
 * [OUTPUT]: Interactive scheme A preview with live state changes and overflow
 * [POS]: /design reaction examples; never accesses backend or sends messages
 * [PROTOCOL]: Keep fixtures aligned with the member response projection contract
 */
import { useState } from "react";
import dynamic from "next/dynamic";
import Select from "@/components/ui/Select";
import Card from "@/components/ui/Card";
import AgentMessageReactions, { ReactionMotionContext } from "@/components/team/AgentMessageReactions";
import { TeamMessageFeedbackContext } from "@/components/team/TeamMessageFeedback";
import type { DashboardMessage, RoomReplyActivity } from "@/lib/types";
import { responseLabels } from "@/lib/message-response-activity";
import type { ResponseState } from "@/lib/message-response-activity";
const states = Object.keys(responseLabels) as ResponseState[];
// Chat timestamps use the viewer's locale; preview the client-rendered bubble
// as in the dashboard, without server/client locale mismatches in this gallery.
const MessageBubble = dynamic(() => import("@/components/dashboard/MessageBubble"), { ssr: false });
const avatars = ["jellyfish-cyan", "cat-coral", "octopus-violet", "wizard-blue", "dinosaur-green"];
function fixture(state: ResponseState, i: number): RoomReplyActivity {
  return { agent_id: `agent-${i}`, agent_name: i === 0 ? "Atlas · 项目助手" : `Agent ${i + 1}`,
    avatar_url: `/agent-avatars/${avatars[i % avatars.length]}.svg`, response_state: state, status: "processing", basis: "run",
    reason: state === "ignored" ? "attention_policy" : state === "interrupted" ? "lease_expired" : null,
    derived: state === "interrupted", updated_at: "2026-10-14T08:30:00Z" };
}
export default function AgentReactionPreview() {
  const [state, setState] = useState<ResponseState>("processing");
  return <section id="agent-reactions" className="space-y-4">
    <h2 className="type-heading-2">消息状态 · 头像角标</h2>
    <p className="text-sm text-text-secondary">方案 A。点击头像或 +N 查看详情；手机上点击整行。切换状态可检查已打开面板的刷新。</p>
    <Select aria-label="模拟 Agent 状态" value={state} onChange={(e) => setState(e.target.value as ResponseState)}>
      {states.map((s) => <option key={s} value={s}>{responseLabels[s][0]}</option>)}
    </Select>
    <ReactionMotionContext.Provider value="preview:agent-0">
      <Card className="space-y-4"><p className="text-sm">帮我整理今天的会议结论。</p><AgentMessageReactions messageId="preview" activity={[fixture(state, 0)]} /></Card>
      <Card className="space-y-4"><p className="text-sm">所有 Agent 请确认各自负责的事项。</p><AgentMessageReactions messageId="crowded" activity={Array.from({ length: 12 }, (_, i) => fixture(states[i % states.length], i))} /></Card>
      <Card className="space-y-4">
        <p className="text-xs text-text-secondary">真实消息组件 · 本地状态样例</p>
        <TeamMessageFeedbackContext.Provider value>
          <MessageBubble isOwn message={{ hub_msg_id: "reaction-demo", msg_id: "reaction-demo", room_id: "rm_reaction_demo", sender_id: "hu_demo", sender_name: "你", sender_kind: "human", is_mine: true,
            type: "message", text: "早上的构建已经恢复，请各位确认自己负责的模块是否正常。", payload: {}, state: "delivered", created_at: "2026-10-14T08:30:00Z",
            reply_activity: Array.from({ length: 12 }, (_, i) => fixture(states[i % states.length], i)),
          } as unknown as DashboardMessage} />
        </TeamMessageFeedbackContext.Provider>
      </Card>
    </ReactionMotionContext.Provider>
  </section>;
}
